/**
 * Format-preserving, in-place masking.
 *
 * The output file is the SAME format as the input — the original file is opened
 * and only the sensitive values are replaced with "XXXX"; all other content,
 * styling, and structure is left untouched.
 *
 *   xlsx — targeted cell splice inside the original zip (replaceCellsInXlsx):
 *          only masked <c> elements change; all other bytes are preserved
 *   csv  — plain-text replacement (BOM preserved)
 *   docx — the OOXML zip is opened and only the text runs inside
 *          word/document.xml (+ headers/footers/notes) are edited
 *   pdf  — handled separately by pdf-redactor.ts (visual redaction bars)
 */

import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { SpreadsheetMaskPlan } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('file-masker');

const MASK = 'XXXX';

// ── Shared text replacement ───────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive, whitespace-flexible, dash-flexible matcher for one sensitive value. */
function valuePattern(value: string): RegExp {
  return new RegExp(
    escapeRegExp(value)
      .replace(/\s+/g, '\\s*')            // flexible whitespace (including none)
      .replace(/[-–—]/g, '[-–—]'), // hyphen, en-dash, em-dash interchangeable
    'gi'
  );
}

/** Replace every occurrence of every value with XXXX. */
export function maskText(text: string, values: string[]): string {
  let out = text;
  for (const v of values) {
    if (!v || v.trim().length < 2) continue;
    out = out.replace(valuePattern(v), MASK);
  }
  return out;
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export function maskCsv(buffer: Buffer, values: string[]): Buffer {
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const masked = maskText(text, values);
  logger.info(`CSV masked (${values.length} values)`);
  return Buffer.from((hasBom ? '\uFEFF' : '') + masked, 'utf8');
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

const SCALE_MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, million: 1e6,
  b: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
};

/**
 * All standalone numeric tokens embedded in a sensitive value string.
 *
 * A token must NOT be glued to a preceding letter or letter-hyphen — this stops
 * vendor codes like "SG-01" from yielding the number 1 and masking every
 * unrelated cell containing 1. Scale suffixes are recognised: "150M" yields
 * both 150 (a cell in a "millions" column) and 150000000 (a raw-value cell).
 */
function extractNumbers(value: string): number[] {
  const nums = new Set<number>();
  const re = /(?<![A-Za-z0-9])(?<![A-Za-z]-)(\d[\d,]*(?:\.\d+)?)\s?(trillion|billion|million|thousand|[TtBbMmKk](?![A-Za-z]))?/g;
  for (const m of value.matchAll(re)) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    nums.add(n);
    const scale = m[2] ? SCALE_MULTIPLIER[m[2].toLowerCase()] : undefined;
    if (scale) nums.add(n * scale);
  }
  return [...nums];
}

/**
 * Returns true if `num` (an Excel cell's stored value) matches the sensitive
 * value string `val` in any of these ways:
 *
 *   • Direct equality          — "7350000" matches cell 7350000
 *   • Percentage decimal form  — cell stores 0.07, val is "7" or "7%" → 0.07×100 = 7
 *   • Approximate equality     — handles minor floating-point drift
 *
 * The *100 check is applied unconditionally for numbers < 1 (they are almost
 * certainly stored as percentage decimals) AND whenever val contains "%".
 */
function numberMatchesValue(num: number, val: string): boolean {
  const extracted = extractNumbers(val);
  if (extracted.length === 0) return false;

  for (const parsed of extracted) {
    // Direct match (tolerant of floating-point drift)
    if (Math.abs(num - parsed) <= Math.max(1e-9, Math.abs(parsed) * 1e-9)) return true;

    // Percentage cells: stored as decimal (0.07) but AI/pattern sees "7" or "7%".
    // Apply × 100 conversion only when the value plausibly IS a percentage:
    // it contains "%" or is a bare number ("7"). A currency amount like
    // "USD 50" must NOT match a ratio cell holding 0.5.
    const percentish = val.includes('%') || /^[\d.,\s]+$/.test(val.trim());
    if (percentish && ((num > 0 && num < 1) || val.includes('%'))) {
      if (Math.abs(num * 100 - parsed) <= Math.max(1e-6, Math.abs(parsed) * 1e-6)) return true;
    }
  }
  return false;
}

export async function maskXlsx(buffer: Buffer, values: string[]): Promise<Buffer> {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  // Numeric safety net: every raw number embedded in every sensitive value —
  // catches cells whose stored number differs from the AI's formatted view
  // (e.g. AI said "SGD 7,350,000" but the cell stores 7350000).
  const allSensitiveNumbers = new Set<number>();
  const percentNumbers = new Set<number>(); // numbers from values containing "%"
  for (const v of values) {
    for (const n of extractNumbers(v)) {
      allSensitiveNumbers.add(n);
      if (v.includes('%')) percentNumbers.add(n);
    }
  }

  const numericSweepMatch = (num: number): boolean => {
    for (const sensitive of allSensitiveNumbers) {
      if (Math.abs(num - sensitive) <= Math.max(1e-9, Math.abs(sensitive) * 1e-9)) return true;
      // Percentage decimal: cell=0.07, sensitive=7 — only for values that
      // explicitly contained "%" (otherwise "USD 50" would mask 0.5)
      if (num > 0 && num < 1 && percentNumbers.has(sensitive) && sensitive <= 100) {
        if (Math.abs(num * 100 - sensitive) <= 1e-6) return true;
      }
    }
    return false;
  };

  const targets = new Map<string, Map<string, string>>();
  let cellsMasked = 0;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const refs = new Map<string, string>();
    for (const ref of Object.keys(sheet)) {
      if (!/^[A-Z]+\d+$/.test(ref)) continue;
      const cell = sheet[ref] as { v?: unknown; t?: string };
      if (cell.v === null || cell.v === undefined) continue;

      // String-like cells: partial replacement preserved ("Total: SGD 150M" →
      // "Total: XXXX"). Formula/rich-text nuances collapse to plain text.
      if (typeof cell.v === 'string') {
        const masked = maskText(cell.v, values);
        if (masked !== cell.v) { refs.set(ref, masked); cellsMasked++; }
        continue;
      }

      // Numeric cells (incl. formula results): the AI sees the formatted
      // representation ("SGD 150,000,000", "7%") but the cell stores the raw
      // number. Masking replaces the whole cell (and drops any formula — the
      // static XXXX is safer than a recalculation revealing the original).
      if (typeof cell.v === 'number') {
        if (values.some((val) => numberMatchesValue(cell.v as number, val)) || numericSweepMatch(cell.v)) {
          refs.set(ref, MASK);
          cellsMasked++;
        }
      }
    }
    if (refs.size > 0) targets.set(sheetName, refs);
  }

  logger.info(`XLSX masked: ${cellsMasked} cell(s) changed`);
  return replaceCellsInXlsx(buffer, targets);
}

// ── DOCX ──────────────────────────────────────────────────────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface Segment {
  open: string;    // the <w:t ...> tag
  close: string;   // </w:t>
  text: string;    // decoded text content
  start: number;   // offset of this segment's text in the paragraph concat
}

/**
 * Mask sensitive values inside one OOXML part (document.xml, header1.xml, …).
 *
 * Word splits text into runs arbitrarily ("SGD 150," + "000,000"), so per
 * paragraph we concatenate all <w:t> contents, locate each value in the joined
 * text, then write the mask back across the affected runs: the first covered
 * run gets "XXXX", the rest of the covered text is removed. Run formatting and
 * everything else in the XML is untouched.
 */
export function maskDocXml(xml: string, values: string[]): string {
  const T_RE = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;

  return xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (para) => {
    // Collect text segments of this paragraph
    const segments: Segment[] = [];
    let concat = '';
    para.replace(T_RE, (_m, open: string, body: string, close: string) => {
      const text = decodeXml(body);
      segments.push({ open, close, text, start: concat.length });
      concat += text;
      return _m;
    });
    if (!concat) return para;

    // Plan edits: per segment, list of [localStart, localEnd, replacement]
    const edits = new Map<number, Array<[number, number, string]>>();
    let any = false;

    for (const value of values) {
      if (!value || value.trim().length < 2) continue;
      const re = valuePattern(value);
      for (const m of concat.matchAll(re)) {
        const s = m.index ?? 0;
        const e = s + m[0].length;
        let first = true;
        segments.forEach((seg, idx) => {
          const segEnd = seg.start + seg.text.length;
          if (segEnd <= s || seg.start >= e) return;
          const ls = Math.max(0, s - seg.start);
          const le = Math.min(seg.text.length, e - seg.start);
          const list = edits.get(idx) ?? [];
          list.push([ls, le, first ? MASK : '']);
          edits.set(idx, list);
          first = false;
          any = true;
        });
      }
    }
    if (!any) return para;

    // Apply edits right-to-left per segment, then rebuild the paragraph XML
    let segIdx = 0;
    return para.replace(T_RE, (_m, open: string, _body: string, close: string) => {
      const seg = segments[segIdx];
      const list = edits.get(segIdx) ?? [];
      segIdx++;
      let text = seg.text;
      for (const [ls, le, repl] of list.sort((a, b) => b[0] - a[0])) {
        text = text.slice(0, ls) + repl + text.slice(le);
      }
      return open + encodeXml(text) + close;
    });
  });
}

// ── Legacy DOC (Word 97–2003 binary) ──────────────────────────────────────────
//
// The OLE compound format stores absolute offsets everywhere, so the file stays
// valid only if the replacement has EXACTLY the same byte length as the original.
// Each sensitive value is therefore overwritten with "XXXX…" padded/truncated to
// the value's own character count, searched in both encodings Word uses for
// document text (UTF-16LE and 8-bit CP1252/latin1).

function xMask(len: number): string {
  return 'X'.repeat(Math.max(1, len));
}

function replaceAllBytes(buf: Buffer, needle: Buffer, replacement: Buffer): number {
  let count = 0;
  let idx = buf.indexOf(needle);
  while (idx !== -1) {
    replacement.copy(buf, idx);
    count++;
    idx = buf.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function maskDocBinary(buffer: Buffer, values: string[]): Buffer {
  const out = Buffer.from(buffer); // work on a copy
  let hits = 0;

  for (const value of values) {
    if (!value || value.trim().length < 2) continue;
    const mask = xMask(value.length);

    // UTF-16LE (unicode pieces) — exact case, plus upper/lower fallbacks
    for (const variant of new Set([value, value.toUpperCase(), value.toLowerCase()])) {
      hits += replaceAllBytes(out, Buffer.from(variant, 'utf16le'), Buffer.from(mask, 'utf16le'));
      // 8-bit pieces (CP1252 ≈ latin1 for the characters we handle)
      hits += replaceAllBytes(out, Buffer.from(variant, 'latin1'), Buffer.from(mask, 'latin1'));
    }
  }

  logger.info(`DOC masked: ${hits} byte-range(s) overwritten`);
  return out;
}

// ── AI-direct Excel masking ───────────────────────────────────────────────────
//
// The AI reads the spreadsheet natively and returns a CSV where every sensitive
// cell has been replaced with "XXXX".  We compare that CSV to the original cell
// values to locate exactly which cells changed, then update only those cells in
// the original ExcelJS workbook so all formatting, widths, and merged regions
// are preserved.

/** Split one CSV row into fields, respecting double-quoted fields. */
function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuote && row[i + 1] === '"') { cur += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      fields.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Apply the AI-produced CSV to the original XLSX.
 * Cells where the AI output "XXXX" (case-insensitive) but the original had a
 * non-empty value are masked; everything else is left untouched.
 */
export async function maskXlsxFromAiCsv(
  originalBuffer: Buffer,
  aiCsv: string
): Promise<Buffer> {
  // Strip markdown fences the model might wrap the CSV in
  const raw = aiCsv.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();

  // Parse original workbook (for reading formatted cell values per sheet)
  const origWb = XLSX.read(originalBuffer, { type: 'buffer' });

  // Masked cells are spliced into the original zip at the end — never a full
  // workbook rewrite (see replaceCellsInXlsx).
  const targets = new Map<string, Map<string, string>>();

  // ── Split AI output into per-sheet sections ──────────────────────────────────
  // The AI prefixes each sheet with: ===SHEET:{name}===
  // If no markers are present, treat the whole output as the first sheet.
  interface SheetSection { name: string; csv: string; }
  const sections: SheetSection[] = [];
  const MARKER = /^===SHEET:(.+)===$/;

  const lines = raw.split('\n');
  let curName = origWb.SheetNames[0];
  let curLines: string[] = [];

  for (const line of lines) {
    const m = line.trim().match(MARKER);
    if (m) {
      if (curLines.length > 0) sections.push({ name: curName, csv: curLines.join('\n') });
      curName = m[1].trim();
      curLines = [];
    } else {
      curLines.push(line);
    }
  }
  if (curLines.length > 0) sections.push({ name: curName, csv: curLines.join('\n') });

  // If AI returned no markers, fall back: one section mapped to first sheet
  if (sections.length === 0) {
    sections.push({ name: origWb.SheetNames[0], csv: raw });
  }

  logger.info(`AI returned ${sections.length} sheet section(s) for ${origWb.SheetNames.length} sheet(s)`);

  let totalCellsMasked = 0;

  for (const section of sections) {
    // Find matching worksheet by name
    const sheetIdx = origWb.SheetNames.findIndex(
      (n) => n.trim().toLowerCase() === section.name.toLowerCase()
    );
    if (sheetIdx === -1) {
      logger.warn(`AI sheet "${section.name}" not found in workbook — skipping`);
      continue;
    }

    const origSheetName = origWb.SheetNames[sheetIdx];
    const origRows = XLSX.utils.sheet_to_json<string[]>(
      origWb.Sheets[origSheetName], { header: 1, defval: '', raw: false }
    ) as string[][];

    const refs = targets.get(origSheetName) ?? new Map<string, string>();
    targets.set(origSheetName, refs);

    // sheet_to_json rows start at the sheet's !ref origin (not always A1) —
    // offset the cell refs accordingly.
    const origin = XLSX.utils.decode_range(
      (origWb.Sheets[origSheetName]['!ref'] as string | undefined) ?? 'A1'
    ).s;

    const aiRows = section.csv.split('\n').filter((l) => l.trim() !== '').map(splitCsvRow);
    let cellsMasked = 0;

    const rowCount = Math.min(aiRows.length, origRows.length);

    // Claude's native spreadsheet view sometimes prefixes an index column to
    // its CSV output, shifting every field right by one. Detect the constant
    // shift from the header row — without this the positional compare finds
    // ZERO matches and the file is served back silently unmasked.
    const detectShift = (aiRow: string[], origRow: string[]): number => {
      let best = 0, bestScore = -1;
      for (const s of [0, 1, 2]) {
        let score = 0;
        for (let c = 0; c < origRow.length; c++) {
          const a = (aiRow[c + s] ?? '').trim();
          const o = String(origRow[c] ?? '').trim();
          if (o !== '' && a.toLowerCase() === o.toLowerCase()) score++;
        }
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return best;
    };
    const shift = rowCount > 0 ? detectShift(aiRows[0], origRows[0]) : 0;
    if (shift > 0) logger.info(`Sheet "${origSheetName}": AI output column shift = ${shift}`);

    for (let r = 0; r < rowCount; r++) {
      const aiRow = aiRows[r];
      const origRow = origRows[r];
      for (let c = 0; c < origRow.length; c++) {
        const aiVal = (aiRow[c + shift] ?? '').trim();
        const origVal = String(origRow[c] ?? '').trim();
        if (aiVal.toUpperCase() === MASK && origVal !== '' && origVal.toUpperCase() !== MASK) {
          refs.set(`${colLetters(c + origin.c)}${r + 1 + origin.r}`, MASK);
          cellsMasked++;
          logger.info(`  [${origSheetName}] cell [${r + 1 + origin.r},${c + 1 + origin.c}]: "${origVal}" → XXXX`);
        }
      }
    }

    logger.info(`Sheet "${origSheetName}": ${cellsMasked} cell(s) masked`);
    totalCellsMasked += cellsMasked;
  }

  logger.info(`AI-direct XLSX masking complete: ${totalCellsMasked} total cell(s) replaced`);
  return replaceCellsInXlsx(originalBuffer, targets);
}

// ── AI-direct CSV masking ─────────────────────────────────────────────────────
//
// Same philosophy as maskXlsxFromAiCsv: the AI output is used ONLY to decide
// WHICH cells to mask — it is never written to disk. The AI tends to re-flow
// the file (adds ===SHEET:=== markers, splits quoted multi-line cells into
// separate rows, drops/pads columns), so instead of trusting its serialization
// we parse the ORIGINAL csv with exact character offsets and splice "XXXX"
// over just the cells the AI masked. Every other byte is preserved.

interface CsvCellSpan {
  value: string;  // decoded field content (quotes stripped, "" unescaped)
  start: number;  // offset of the field in the original text (incl. quotes)
  end: number;    // offset one past the field (excl. the delimiter)
}

/** RFC 4180 parser that keeps each field's exact character span. */
function parseCsvWithSpans(text: string): CsvCellSpan[][] {
  const records: CsvCellSpan[][] = [];
  let row: CsvCellSpan[] = [];
  let value = '';
  let fieldStart = 0;
  let inQuote = false;
  let i = 0;

  const endField = (end: number) => {
    row.push({ value, start: fieldStart, end });
    value = '';
  };
  const endRecord = () => {
    records.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      value += ch; i++; continue;
    }
    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === ',') { endField(i); i++; fieldStart = i; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { endField(i); endRecord(); i += 2; fieldStart = i; continue; }
    if (ch === '\n' || ch === '\r') { endField(i); endRecord(); i++; fieldStart = i; continue; }
    value += ch; i++;
  }
  // Trailing field (file not ending in a newline)
  if (value !== '' || row.length > 0 || fieldStart < text.length) {
    endField(text.length);
    endRecord();
  }
  return records;
}

/**
 * Score how well one AI-output row lines up with one original record.
 *   eq       — non-empty cells that agree
 *   neq      — non-empty cells that conflict
 *   maskCols — columns where the AI wrote XXXX over a non-empty original value
 * Empty-vs-non-empty differences are neutral: the AI pads/truncates rows freely.
 */
function scoreRowAlignment(
  origRow: CsvCellSpan[],
  aiRow: string[]
): { eq: number; neq: number; maskCols: number[] } {
  const n = Math.min(origRow.length, aiRow.length);
  let eq = 0;
  let neq = 0;
  const maskCols: number[] = [];
  for (let c = 0; c < n; c++) {
    const o = origRow[c].value.replace(/\s+/g, ' ').trim();
    const a = aiRow[c].replace(/\s+/g, ' ').trim();
    if (a.toUpperCase() === MASK) {
      if (o !== '' && o.toUpperCase() !== MASK) maskCols.push(c);
      continue;
    }
    if (o === '' || a === '') continue;
    if (o === a) eq++;
    else neq++;
  }
  return { eq, neq, maskCols };
}

export interface CsvMaskResult {
  buffer: Buffer;
  maskedCount: number;
  detections: Array<{ value: string; header: string }>;
}

/**
 * Apply the AI-produced CSV to the original CSV file.
 *
 * The original text is kept verbatim; only cells the AI replaced with "XXXX"
 * are spliced. AI rows are aligned to original records with a forward-scanning
 * greedy matcher, so extra rows the AI invents (sheet markers, multi-line
 * header cells split apart) are skipped instead of corrupting the output.
 */
export function maskCsvFromAiCsv(originalBuffer: Buffer, aiCsv: string): CsvMaskResult {
  const hasBom =
    originalBuffer.length >= 3 &&
    originalBuffer[0] === 0xef && originalBuffer[1] === 0xbb && originalBuffer[2] === 0xbf;
  const text = originalBuffer.toString('utf8').replace(/^\uFEFF/, '');
  const origRecords = parseCsvWithSpans(text);

  // Strip markdown fences and ===SHEET:...=== marker rows from the AI output
  const cleaned = aiCsv.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();
  const aiRows = parseCsvWithSpans(cleaned)
    .map((r) => r.map((c) => c.value))
    .filter((r) => !(r.length > 0 && /^===\s*SHEET:.*===$/.test(r[0].trim())));

  const headers = origRecords.length > 0 ? origRecords[0].map((c) => c.value.trim()) : [];

  const replacements: Array<{ start: number; end: number }> = [];
  const detections: Array<{ value: string; header: string }> = [];
  const seen = new Set<string>();

  const LOOKAHEAD = 30; // AI rows to scan forward before giving up on a record
  let aiIdx = 0;

  for (const origRow of origRecords) {
    let matched: number[] | null = null;
    const limit = Math.min(aiRows.length, aiIdx + LOOKAHEAD);
    for (let j = aiIdx; j < limit; j++) {
      const { eq, neq, maskCols } = scoreRowAlignment(origRow, aiRows[j]);
      // Accept the first AI row that agrees with this record: either a clear
      // content match, or a conflict-free row that masks something.
      if ((eq > 0 && eq >= neq) || (neq === 0 && maskCols.length > 0)) {
        matched = maskCols;
        aiIdx = j + 1;
        break;
      }
    }
    if (!matched) continue; // no aligned AI row — leave this record untouched

    for (const c of matched) {
      const cell = origRow[c];
      replacements.push({ start: cell.start, end: cell.end });
      const v = cell.value.trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        detections.push({ value: v, header: headers[c] ?? '' });
      }
    }
  }

  // Splice right-to-left so earlier offsets stay valid
  let out = text;
  for (const { start, end } of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + MASK + out.slice(end);
  }

  logger.info(`CSV masked via AI alignment: ${replacements.length} cell(s), ${origRecords.length} record(s) preserved`);
  return {
    buffer: Buffer.from((hasBom ? '\uFEFF' : '') + out, 'utf8'),
    maskedCount: replacements.length,
    detections,
  };
}

// ── Plan-based masking for large spreadsheets ─────────────────────────────────
//
// The AI returns a small column/value plan (see planSpreadsheetMasking); these
// appliers execute it mechanically over EVERY row, so masking is deterministic
// and scales to any file size — no AI re-emission of the data involved.

export interface PlanApplyResult {
  buffer: Buffer;
  maskedCount: number;
  // per-column / per-value outcomes, keyed back to the plan by (si, ci)/(si, vi)
  columns: Array<{ si: number; ci: number; sheet: string | null; header: string; count: number }>;
  values: Array<{ si: number; vi: number; value: string; count: number }>;
  // numeric-sweep outcomes per sheet (fieldId plansweep_{si} on the review page)
  sweeps: Array<{ si: number; sheet: string | null; count: number }>;
}

// The AI's plan is built from SAMPLED rows, so a value-based sheet can never
// enumerate everything — this deterministic sweep catches any remaining cell
// shaped like money or a percentage on sheets the plan already deemed
// sensitive. Quantities/dates/ids (plain integers) intentionally don't match.
const SWEEP_PATTERNS: RegExp[] = [
  /^[~$€£]?\s*-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/,                                      // 411,960.95 / $ 1,254.40
  /^(?:USD|SGD|EUR|MYR|IDR|GBP|JPY|AUD|CHF|\$|€|£)\s*-?[\d,]+(?:\.\d+)?\s*[MKB]?(?:\/\w+)?$/i, // SGD 150M, ~USD 11.75M/MW
  /^-?\d+(?:\.\d+)?\s*%$/,                                                           // 12%, 7.5 %
  /^\$\s*-$/,                                                                        // "$ -" zero price cells
];

function matchesSweep(raw: string): boolean {
  const v = raw.replace(/\s+/g, ' ').trim();
  if (v === '') return false;
  return SWEEP_PATTERNS.some((re) => re.test(v));
}

function findColumnIndex(headerRow: string[], headerText: string): number {
  const want = headerText.trim().toLowerCase();
  return headerRow.findIndex((h) => String(h ?? '').trim().toLowerCase() === want);
}

/** Normalise a header label: collapse all whitespace (incl. wrapped-cell newlines). */
function normLabel(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Find every cell in the grid whose text equals the header label. Real-world
 * workbooks have title blocks, multi-row headers, section rows, and the same
 * column group repeated (Year 01 / Year 02 …) — so a label can sit on any row
 * and appear several times, and each occurrence marks a column to mask below.
 */
function findHeaderCells(grid: string[][], headerText: string): Array<{ r: number; c: number }> {
  const want = normLabel(headerText);
  if (want === '') return [];
  const found: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (normLabel(String(row[c] ?? '')) === want) found.push({ r, c });
    }
  }
  return found;
}

/** 0-based column index → Excel letters (0 → A, 26 → AA). */
function colLetters(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Replace specific cells with "XXXX" by editing the worksheet XML inside the
 * original xlsx zip directly. Rewriting the workbook with a library (ExcelJS)
 * corrupts files authored by other tools — a plain load→save round trip of a
 * SheetJS-generated workbook already fails Excel's validation — so only the
 * targeted <c> elements are touched and every other byte is preserved.
 *
 * targets: sheet name → (cell ref "D5" → replacement text).
 */
async function replaceCellsInXlsx(
  originalBuffer: Buffer,
  targets: Map<string, Map<string, string>>
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);

  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbookXml || !relsXml) throw new Error('Invalid xlsx: missing workbook parts');

  // sheet name → r:id, then r:id → worksheet part path
  const nameToRid = new Map<string, string>();
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = m[0];
    const name = tag.match(/\bname="([^"]*)"/)?.[1];
    const rid = tag.match(/\br:id="([^"]*)"/)?.[1];
    if (name && rid) nameToRid.set(unescapeXml(name).trim().toLowerCase(), rid);
  }
  const ridToPath = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = m[0];
    const id = tag.match(/\bId="([^"]*)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]*)"/)?.[1];
    if (id && target) ridToPath.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  for (const [sheetName, refs] of targets) {
    if (refs.size === 0) continue;
    const rid = nameToRid.get(sheetName.trim().toLowerCase());
    const path = rid ? ridToPath.get(rid) : undefined;
    const file = path ? zip.file(path) : null;
    if (!file) {
      logger.warn(`replaceCellsInXlsx: worksheet part for "${sheetName}" not found — skipping`);
      continue;
    }
    let xml = await file.async('string');
    let replaced = 0;
    // Shared-formula group ids whose DEFINITION cell (the one carrying ref=)
    // gets masked — their follower cells would be left pointing at a formula
    // that no longer exists, which Excel flags as corruption.
    const brokenShared = new Set<string>();

    // One pass over every <c> element; masked cells become inline strings.
    xml = xml.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, (cell) => {
      const ref = cell.match(/\br="([A-Z]+\d+)"/)?.[1];
      const replacement = ref ? refs.get(ref) : undefined;
      if (replacement === undefined) return cell;
      const f = cell.match(/<f\b[^>]*>/)?.[0];
      if (f && /\bt="shared"/.test(f) && /\bref="/.test(f)) {
        const si = f.match(/\bsi="(\d+)"/)?.[1];
        if (si !== undefined) brokenShared.add(si);
      }
      const style = cell.match(/\bs="(\d+)"/)?.[1];
      replaced++;
      return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr">` +
        `<is><t xml:space="preserve">${encodeXml(replacement)}</t></is></c>`;
    });

    // Demote followers of broken shared formulas to their cached values: strip
    // just the <f/> element, keeping the cell's stored <v> result.
    if (brokenShared.size > 0) {
      let demoted = 0;
      xml = xml.replace(/<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/g, (f) => {
        if (!/\bt="shared"/.test(f) || /\bref="/.test(f)) return f;
        const si = f.match(/\bsi="(\d+)"/)?.[1];
        if (si === undefined || !brokenShared.has(si)) return f;
        demoted++;
        return '';
      });
      logger.info(`replaceCellsInXlsx: "${sheetName}": ${demoted} shared-formula follower(s) demoted to values`);
    }

    zip.file(path!, xml);
    logger.info(`replaceCellsInXlsx: "${sheetName}": ${replaced}/${refs.size} cell(s) replaced`);
  }

  // Masked cells may have carried formulas; the calc chain is a cache indexed
  // by formula cell and Excel flags the file when entries point at cells that
  // no longer calculate. It is safe to drop — Excel rebuilds it on open — but
  // its registrations must go with it or the package itself becomes invalid.
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    const ct = await zip.file('[Content_Types].xml')?.async('string');
    if (ct) {
      zip.file('[Content_Types].xml', ct.replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''));
    }
    const wbRels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    if (wbRels) {
      zip.file('xl/_rels/workbook.xml.rels', wbRels.replace(/<Relationship[^>]*Target="calcChain\.xml"[^>]*\/>/g, ''));
    }
    logger.info('replaceCellsInXlsx: dropped stale calcChain.xml (Excel rebuilds it)');
  }

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return Buffer.from(out);
}

export async function maskXlsxByPlan(
  originalBuffer: Buffer,
  plan: SpreadsheetMaskPlan
): Promise<PlanApplyResult> {
  const origWb = XLSX.read(originalBuffer, { type: 'buffer' });

  const columns: PlanApplyResult['columns'] = [];
  const values: PlanApplyResult['values'] = [];
  const sweeps: PlanApplyResult['sweeps'] = [];
  const targets = new Map<string, Map<string, string>>();
  let maskedCount = 0;

  plan.sheets.forEach((sheetPlan, si) => {
    // Match by name; fall back to position — plan order mirrors workbook order,
    // so a mangled sheet name must not silently leave that sheet unmasked.
    let sheetIdx = sheetPlan.name === null
      ? si
      : origWb.SheetNames.findIndex((n) => n.trim().toLowerCase() === sheetPlan.name!.trim().toLowerCase());
    if (sheetIdx === -1 && si < origWb.SheetNames.length) {
      logger.warn(`Plan sheet "${sheetPlan.name}" not found by name — using position ${si} ("${origWb.SheetNames[si]}")`);
      sheetIdx = si;
    }
    if (sheetIdx === -1) {
      logger.warn(`Plan sheet "${sheetPlan.name}" not found in workbook — skipping`);
      return;
    }
    const origSheetName = origWb.SheetNames[sheetIdx];
    const origRows = XLSX.utils.sheet_to_json<string[]>(
      origWb.Sheets[origSheetName], { header: 1, defval: '', raw: false }
    ) as string[][];
    const refs = targets.get(origSheetName) ?? new Map<string, string>();
    targets.set(origSheetName, refs);

    // sheet_to_json rows start at the sheet's !ref origin, which is NOT always
    // A1 (e.g. a range of "A2:M49") — offset the cell refs accordingly or every
    // mask lands one row/column off.
    const origin = XLSX.utils.decode_range(
      (origWb.Sheets[origSheetName]['!ref'] as string | undefined) ?? 'A1'
    ).s;

    // All plan labels (normalised) — data cells matching one of these are
    // repeated header rows inside the data area and must not be masked.
    const allLabels = new Set(sheetPlan.maskColumns.map(normLabel));

    const maskCell = (r: number, c: number): boolean => {
      const ref = `${colLetters(c + origin.c)}${r + 1 + origin.r}`;
      if (refs.has(ref)) return false;
      const orig = String(origRows[r]?.[c] ?? '').trim();
      if (orig === '' || orig.toUpperCase() === MASK) return false;
      refs.set(ref, MASK);
      maskedCount++;
      return true;
    };

    sheetPlan.maskColumns.forEach((headerText, ci) => {
      // Header labels can sit on any row (title blocks, multi-row headers) and
      // repeat across column groups (Year 01 / Year 02 …) — mask below every
      // occurrence, skipping repeated header labels inside the data area.
      let headerCells = findHeaderCells(origRows, headerText);
      if (headerCells.length === 0) {
        const col = findColumnIndex((origRows[0] ?? []).map(String), headerText);
        if (col !== -1) headerCells = [{ r: 0, c: col }];
      }
      let count = 0;
      if (headerCells.length === 0) {
        logger.warn(`Plan column "${headerText}" not found in sheet "${origSheetName}"`);
      } else {
        for (const { r: hr, c: hc } of headerCells) {
          for (let r = hr + 1; r < origRows.length; r++) {
            const val = String(origRows[r]?.[hc] ?? '');
            if (val.trim() === '' || allLabels.has(normLabel(val))) continue;
            if (maskCell(r, hc)) count++;
          }
        }
      }
      columns.push({ si, ci, sheet: sheetPlan.name && origSheetName, header: headerText, count });
    });

    sheetPlan.maskValues.forEach((value, vi) => {
      const want = value.trim();
      let count = 0;
      if (want !== '') {
        for (let r = 1; r < origRows.length; r++) {
          for (let c = 0; c < (origRows[r]?.length ?? 0); c++) {
            if (String(origRows[r][c] ?? '').trim() === want && maskCell(r, c)) count++;
          }
        }
      }
      values.push({ si, vi, value, count });
    });

    // Deterministic numeric sweep — only on sheets the plan deemed sensitive.
    if ((sheetPlan.maskColumns.length > 0 || sheetPlan.maskValues.length > 0) && sheetPlan.sweepNumbers !== false) {
      let count = 0;
      for (let r = 0; r < origRows.length; r++) {
        for (let c = 0; c < (origRows[r]?.length ?? 0); c++) {
          const val = String(origRows[r][c] ?? '');
          if (!matchesSweep(val) || allLabels.has(normLabel(val))) continue;
          if (maskCell(r, c)) count++;
        }
      }
      if (count > 0) logger.info(`Numeric sweep on "${origSheetName}": ${count} extra cell(s)`);
      sweeps.push({ si, sheet: sheetPlan.name && origSheetName, count });
    }

    logger.info(`Plan targets for sheet "${origSheetName}": ${refs.size} cell(s)`);
  });

  const buffer = await replaceCellsInXlsx(originalBuffer, targets);
  logger.info(`Plan-based XLSX masking complete: ${maskedCount} cell(s) across ${plan.sheets.length} sheet(s)`);
  return { buffer, maskedCount, columns, values, sweeps };
}

export function maskCsvByPlan(
  originalBuffer: Buffer,
  plan: SpreadsheetMaskPlan
): PlanApplyResult {
  const hasBom =
    originalBuffer.length >= 3 &&
    originalBuffer[0] === 0xef && originalBuffer[1] === 0xbb && originalBuffer[2] === 0xbf;
  const text = originalBuffer.toString('utf8').replace(new RegExp('^\\uFEFF'), '');
  const records = parseCsvWithSpans(text);
  const grid = records.map((row) => row.map((c) => c.value));
  const sheetPlan = plan.sheets[0] ?? { name: null, maskColumns: [], maskValues: [] };

  const columns: PlanApplyResult['columns'] = [];
  const values: PlanApplyResult['values'] = [];
  const sweeps: PlanApplyResult['sweeps'] = [];
  const spans = new Map<string, { start: number; end: number }>();
  const allLabels = new Set(sheetPlan.maskColumns.map(normLabel));

  const maskCell = (r: number, c: number): boolean => {
    const cell = records[r]?.[c];
    if (!cell) return false;
    const key = `${r}:${c}`;
    if (spans.has(key)) return false;
    const v = cell.value.trim();
    if (v === '' || v.toUpperCase() === MASK) return false;
    spans.set(key, { start: cell.start, end: cell.end });
    return true;
  };

  sheetPlan.maskColumns.forEach((headerText, ci) => {
    // Header labels can sit on any row and repeat — mask below every
    // occurrence, skipping repeated header labels inside the data area.
    let headerCells = findHeaderCells(grid, headerText);
    if (headerCells.length === 0) {
      const col = findColumnIndex(grid[0] ?? [], headerText);
      if (col !== -1) headerCells = [{ r: 0, c: col }];
    }
    let count = 0;
    if (headerCells.length === 0) {
      logger.warn(`Plan column "${headerText}" not found in CSV`);
    } else {
      for (const { r: hr, c: hc } of headerCells) {
        for (let r = hr + 1; r < records.length; r++) {
          const val = grid[r]?.[hc] ?? '';
          if (val.trim() === '' || allLabels.has(normLabel(val))) continue;
          if (maskCell(r, hc)) count++;
        }
      }
    }
    columns.push({ si: 0, ci, sheet: null, header: headerText, count });
  });

  sheetPlan.maskValues.forEach((value, vi) => {
    const want = value.trim();
    let count = 0;
    if (want !== '') {
      for (let r = 1; r < records.length; r++) {
        for (let c = 0; c < records[r].length; c++) {
          if (records[r][c].value.trim() === want && maskCell(r, c)) count++;
        }
      }
    }
    values.push({ si: 0, vi, value, count });
  });

  // Deterministic numeric sweep — only when the plan deemed the data sensitive.
  if ((sheetPlan.maskColumns.length > 0 || sheetPlan.maskValues.length > 0) && sheetPlan.sweepNumbers !== false) {
    let count = 0;
    for (let r = 0; r < records.length; r++) {
      for (let c = 0; c < records[r].length; c++) {
        const val = records[r][c].value;
        if (!matchesSweep(val) || allLabels.has(normLabel(val))) continue;
        if (maskCell(r, c)) count++;
      }
    }
    if (count > 0) logger.info(`Numeric sweep on CSV: ${count} extra cell(s)`);
    sweeps.push({ si: 0, sheet: null, count });
  }

  // Single forward pass — with hundreds of thousands of masked cells, repeated
  // slice-and-concat of the full text would be quadratic and hang the server.
  const sorted = [...spans.values()].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let pos = 0;
  for (const { start, end } of sorted) {
    parts.push(text.slice(pos, start), MASK);
    pos = end;
  }
  parts.push(text.slice(pos));
  const out = parts.join('');

  logger.info(`Plan-based CSV masking complete: ${spans.size} cell(s), ${records.length} record(s) preserved`);
  return {
    buffer: Buffer.from((hasBom ? String.fromCharCode(0xfeff) : '') + out, 'utf8'),
    maskedCount: spans.size,
    columns,
    values,
    sweeps,
  };
}

// ── AI-direct text masking: extract what was replaced ─────────────────────────
//
// For PDF and DOCX the AI returns the full document text with sensitive values
// replaced by XXXX.  This helper recovers the original strings by aligning the
// masked text against the original line-by-line and collecting the spans that
// map to XXXX in the masked version.

/**
 * Given the original document text and the AI-masked version (XXXX substitutions),
 * return the list of unique original strings that were replaced.
 * These strings are passed straight to the existing pdf-redactor / maskDocXml.
 */
export function extractMaskedValuesFromText(
  originalText: string,
  maskedText: string
): string[] {
  const values = new Set<string>();
  const TAG = 'XXXX';

  const origLines = originalText.split('\n');
  const maskLines = maskedText.split('\n');
  const n = Math.min(origLines.length, maskLines.length);

  for (let i = 0; i < n; i++) {
    const orig = origLines[i];
    const mask = maskLines[i];
    if (!mask.includes(TAG) || orig === mask) continue;

    // Split masked line on XXXX to get the text anchors between each substitution
    const parts = mask.split(TAG);
    let origPos = 0;

    for (let p = 0; p < parts.length - 1; p++) {
      const before = parts[p];
      const after  = parts[p + 1];

      // Advance origPos past the `before` prefix
      if (before.length > 0) {
        const idx = orig.indexOf(before, origPos);
        if (idx === -1) break; // lines don't align — give up on this line
        origPos = idx + before.length;
      }

      // Find where the replaced value ends: look for the start of `after`
      let valueEnd: number;
      if (after.length === 0) {
        valueEnd = orig.length;
      } else {
        // `after` may itself contain further XXXX; find just the first segment
        const nextAnchor = after.split(TAG)[0];
        const idx = nextAnchor.length > 0 ? orig.indexOf(nextAnchor, origPos) : origPos;
        valueEnd = idx === -1 ? orig.length : idx;
      }

      const replaced = orig.slice(origPos, valueEnd).trim();
      if (replaced.length > 1) values.add(replaced);

      origPos = valueEnd;
    }
  }

  logger.info(`extractMaskedValues: found ${values.size} unique value(s)`);
  return [...values];
}

// ── Build a new DOCX from masked plain text ───────────────────────────────────
// Used for DOC/DOCX: the AI outputs the full masked text directly (like it
// outputs masked CSV for Excel), and we wrap it in a valid DOCX so the user
// gets a Word document they can open.  Tab-separated lines become table rows.

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CELL_BORDERS =
  '<w:tcPr>' +
  '<w:tcBorders>' +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '</w:tcBorders>' +
  '</w:tcPr>';

const TBL_PROPS =
  '<w:tblPr>' +
  '<w:tblW w:w="0" w:type="auto"/>' +
  '<w:tblBorders>' +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>' +
  '</w:tblBorders>' +
  '</w:tblPr>';

function textToParagraphs(text: string): string {
  const lines = text.split('\n');
  const parts: string[] = [];
  let tableRows: string[] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    parts.push('<w:tbl>' + TBL_PROPS + tableRows.join('') + '</w:tbl>');
    tableRows = [];
  };

  for (const line of lines) {
    const cells = line.split('\t');
    if (cells.length > 1) {
      // Collect as a table row — consecutive rows share one <w:tbl>
      const tcs = cells.map((c) =>
        '<w:tc>' + CELL_BORDERS +
        '<w:p><w:r><w:t xml:space="preserve">' + xmlEsc(c.trim()) + '</w:t></w:r></w:p>' +
        '</w:tc>'
      ).join('');
      tableRows.push('<w:tr>' + tcs + '</w:tr>');
    } else {
      flushTable();
      parts.push('<w:p><w:r><w:t xml:space="preserve">' + xmlEsc(line) + '</w:t></w:r></w:p>');
    }
  }
  flushTable();
  return parts.join('\n');
}

export async function createDocxFromText(maskedText: string): Promise<Buffer> {
  const zip = new JSZip();

  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');

  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');

  zip.file('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
  );

  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    textToParagraphs(maskedText) +
    '<w:sectPr/>' +
    '</w:body>' +
    '</w:document>');

  logger.info(`createDocxFromText: ${maskedText.length} chars → DOCX`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function maskDocx(buffer: Buffer, values: string[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

  let parts = 0;
  for (const name of Object.keys(zip.files)) {
    if (!PARTS.test(name)) continue;
    const xml = await zip.files[name].async('string');
    const masked = maskDocXml(xml, values);
    if (masked !== xml) {
      zip.file(name, masked);
      parts++;
    }
  }

  logger.info(`DOCX masked: ${parts} XML part(s) changed`);
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
