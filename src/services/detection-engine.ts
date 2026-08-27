/**
 * Hybrid detection engine.
 *
 * Combines two independent detectors and reconciles their findings:
 *   1. AI (SAP AI Core)      — semantic understanding, catches names and odd formats
 *   2. Pattern scanner       — deterministic regexes for prices / percentages / vendor codes,
 *                              catches anything the model missed
 *
 * Every finding is then verified against the actual document text:
 *   - occurrence counting (case-insensitive)
 *   - case-correction of the AI's originalValue to the document's exact casing
 *   - context snippet extraction for the review UI
 *   - confidence scoring:
 *       100  AI and pattern scanner agree
 *        90  AI finding verified verbatim in the document
 *        75  pattern-only finding (regex match, AI missed it)
 *        40  AI finding that could NOT be located (possible hallucination — flagged, not dropped)
 */

import { MaskingSuggestion, FieldCategory, Sensitivity } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('detection-engine');

// ── Pattern scanner ───────────────────────────────────────────────────────────

interface PatternHit {
  category: FieldCategory;
  value: string;
}

const CURRENCY = 'SGD|USD|EUR|GBP|MYR|IDR|THB|PHP|VND|INR|JPY|CNY|AUD|NZD|HKD|KRW|S\\$|US\\$|A\\$|\\$|€|£|¥|₹';

// Scale suffixes: T/B/M/K and long-form words
const SCALE = '(?:trillion|billion|million|thousand|[TtBbMmKk])';
// Unit-rate denominator that should be included in the masked value
const UNIT = '(?:/(?:MW|KW|GW|MWh|KWh|kW|m2|sqm|unit|hr))?';

const PATTERNS: Array<{ category: FieldCategory; re: RegExp }> = [
  // Currency-prefixed amounts with optional ~ prefix and optional /unit suffix:
  // "SGD 150,000,000", "~USD 11.75M/MW", "$2,500.00", "SGD150M", "USD 2.5 million", "~USD 122.25K"
  {
    category: 'Price',
    re: new RegExp(
      `~?(?:${CURRENCY})\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?${SCALE})?${UNIT}`,
      'g'
    ),
  },
  // Price ranges: "$ 7K–12K/MW", "$7K-$12K"  (K/M/B suffixed, no comma separator)
  {
    category: 'Price',
    re: new RegExp(
      `~?(?:${CURRENCY})\\s?\\d[\\d.]*${SCALE}(?:[–\\-](?:~?(?:${CURRENCY})\\s?)?\\d[\\d.]*${SCALE})?${UNIT}`,
      'g'
    ),
  },
  // Standalone thousands-separated numbers: "1,500,000" (at least one comma group)
  { category: 'Price', re: /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g },
  // Capacity / power values without currency: "10 MW", "5.5 GW", "100 KWh", "20MW"
  { category: 'Price', re: /\b\d+(?:\.\d+)?\s?(?:MW|GW|KW|MWh|KWh|kW)(?!\w)/g },
  // Percentages: "15%", "7.5 %", "12.5%", "4%", "7%"
  { category: 'Percentage', re: /\b\d{1,3}(?:\.\d+)?\s?%/g },
  // Vendor codes with hyphen: "SG-01", "MY-002", "VN-1"
  { category: 'Vendor Name', re: /\b[A-Z]{2,3}-\d{1,4}\b/g },
  // Vendor name phrases with or without hyphen: "Vendor SG01", "Vendor DE-01"
  { category: 'Vendor Name', re: /\bVendor\s+[A-Z]{2,3}[-]?\d{1,4}\b/gi },
];

export function scanPatterns(text: string): PatternHit[] {
  const seen = new Set<string>();
  const hits: PatternHit[] = [];

  for (const { category, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = m[0].trim();
      const key = `${category}::${norm(value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ category, value });
    }
  }

  logger.info(`Pattern scanner found ${hits.length} unique candidate(s)`);
  return hits;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find all case-insensitive occurrences; returns exact document-cased first match + count. */
function locate(text: string, value: string): { count: number; exact: string; index: number } {
  if (!value) return { count: 0, exact: value, index: -1 };
  const re = new RegExp(escapeRegExp(value).replace(/\s+/g, '\\s+'), 'gi');
  let count = 0;
  let exact = value;
  let index = -1;
  for (const m of text.matchAll(re)) {
    if (count === 0) {
      exact = m[0].replace(/\s+/g, ' ');
      index = m.index ?? -1;
    }
    count++;
  }
  return { count, exact, index };
}

/** Snippet of surrounding text with the value marked by «…». */
function contextSnippet(text: string, index: number, length: number): string {
  if (index < 0) return '';
  const RADIUS = 45;
  const start = Math.max(0, index - RADIUS);
  const end = Math.min(text.length, index + length + RADIUS);
  const before = text.slice(start, index).replace(/\s+/g, ' ');
  const value = text.slice(index, index + length).replace(/\s+/g, ' ');
  const after = text.slice(index + length, end).replace(/\s+/g, ' ');
  const pre = start > 0 ? '…' : '';
  const post = end < text.length ? '…' : '';
  return `${pre}${before}«${value}»${after}${post}`.trim();
}

const SENSITIVITY: Record<FieldCategory, Sensitivity> = {
  'Vendor Name': 'high',
  'Price': 'high',
  'Percentage': 'medium',
};

// ── Reconciliation ────────────────────────────────────────────────────────────

/** Minimal shape of what the AI model returns — enrichment happens here. */
export interface RawAiSuggestion {
  fieldName: FieldCategory;
  originalValue: string;
  reason?: string;
  sensitivity?: Sensitivity;
}

/**
 * Merge AI suggestions with pattern-scanner hits, verify everything against the
 * document text, and return enriched, deduplicated, confidence-scored findings.
 */
export function reconcile(
  documentText: string,
  aiSuggestions: RawAiSuggestion[]
): MaskingSuggestion[] {
  const patternHits = scanPatterns(documentText);
  const results: MaskingSuggestion[] = [];
  const taken = new Map<string, MaskingSuggestion>(); // norm(value) -> finding

  // Pass 1 — AI findings, verified against the document
  for (const s of aiSuggestions) {
    const value = (s.originalValue ?? '').replace(/\s+/g, ' ').trim();
    if (!value || value.length < 2) continue;
    const key = norm(value);
    if (taken.has(key)) continue;

    const loc = locate(documentText, value);
    const verified = loc.count > 0;
    const finalValue = verified ? loc.exact : value;
    const patternAgrees = patternHits.some(
      (h) => norm(h.value) === norm(finalValue) || norm(finalValue).includes(norm(h.value))
    );

    const finding: MaskingSuggestion = {
      fieldId: '',
      fieldName: s.fieldName,
      originalValue: finalValue,
      maskedValue: 'XXXX',
      reason: s.reason || `Detected as ${s.fieldName}`,
      sensitivity: s.sensitivity ?? SENSITIVITY[s.fieldName] ?? 'medium',
      source: verified && patternAgrees ? 'ai+pattern' : 'ai',
      confidence: verified ? (patternAgrees ? 100 : 90) : 40,
      occurrences: loc.count,
      verified,
      context: contextSnippet(documentText, loc.index, finalValue.length),
    };

    taken.set(norm(finalValue), finding);
    if (key !== norm(finalValue)) taken.set(key, finding);
    results.push(finding);

    if (!verified) {
      logger.warn(`AI value not found in document (flagged low-confidence): "${value}"`);
    }
  }

  // Pass 2 — pattern-only findings the AI missed
  for (const hit of patternHits) {
    const key = norm(hit.value);
    if (taken.has(key)) continue;
    // Skip if this hit is a fragment of a VERIFIED AI finding
    // (e.g. AI found and verified "SGD 150,000,000"; scanner also matched "150,000,000")
    // Do NOT skip if the covering AI finding is unverified (confidence 40) — the pattern
    // hit may be the only way to actually locate and redact the value in the document.
    const isFragment = [...taken.entries()].some(([k, f]) => k.includes(key) && f.verified);
    if (isFragment) continue;

    const loc = locate(documentText, hit.value);
    if (loc.count === 0) continue; // shouldn't happen, but be safe

    const finding: MaskingSuggestion = {
      fieldId: '',
      fieldName: hit.category,
      originalValue: loc.exact,
      maskedValue: 'XXXX',
      reason: `Matched ${hit.category.toLowerCase()} pattern — missed by AI scan`,
      sensitivity: SENSITIVITY[hit.category],
      source: 'pattern',
      confidence: 75,
      occurrences: loc.count,
      verified: true,
      context: contextSnippet(documentText, loc.index, loc.exact.length),
    };

    taken.set(key, finding);
    results.push(finding);
  }

  // Stable ordering: category, then position of first occurrence in the document
  const order: Record<string, number> = { 'Vendor Name': 0, 'Price': 1, 'Percentage': 2 };
  results.sort((a, b) => {
    const co = (order[a.fieldName] ?? 9) - (order[b.fieldName] ?? 9);
    if (co !== 0) return co;
    return b.confidence - a.confidence;
  });

  // Assign deterministic field ids
  const counters = new Map<string, number>();
  for (const f of results) {
    const slug = f.fieldName.toLowerCase().replace(/\s+/g, '_');
    const n = (counters.get(slug) ?? 0) + 1;
    counters.set(slug, n);
    f.fieldId = `${slug}_${n}`;
  }

  const aiCount = results.filter((r) => r.source !== 'pattern').length;
  const patternOnly = results.length - aiCount;
  logger.info(
    `Reconciled ${results.length} finding(s): ${aiCount} from AI, ${patternOnly} pattern-only, ` +
    `${results.filter((r) => !r.verified).length} unverified`
  );

  return results;
}
