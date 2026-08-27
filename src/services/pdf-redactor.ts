/**
 * PDF-in-PDF redaction (Node.js, no native dependencies).
 *
 * Matching is SPAN-BASED: a sensitive value is located as a character range
 * inside each text item, and the redaction bar covers only that range — never
 * the whole item. This matters because many PDF generators emit an entire
 * printed line as ONE text item; masking the whole item would black out
 * innocent text sitting on the same line as the sensitive value.
 *
 * Stages per value:
 *   Stage 1 — in-item match      (value occurs inside a single text item)
 *   Stage 2 — line-concat match  (value spans several adjacent items on one line)
 *   Stage 3 — numeric fallback   (value split across baselines, e.g. wrapped
 *                                 table cells; masks the numeric tokens only.
 *                                 Runs only when stages 1–2 found nothing.)
 *
 * All stages use space-collapsed, case-insensitive comparison so that
 * "SGD150,000,000" matches an item run ["SGD", "150,000,000"].
 *
 * Visual style: dark-grey redaction bar with white "XXXX" centred inside.
 */

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('pdf-redactor');

// Disable the web-worker; we run synchronously on the Node.js main thread.
(GlobalWorkerOptions as { workerSrc: string }).workerSrc = '';

// ── Internal types ────────────────────────────────────────────────────────────

interface PdfItem {
  str: string;
  strNorm: string;    // str lowercased (whitespace already collapsed at extraction,
                      // so strNorm.length === str.length and offsets map 1:1)
  x: number;         // left edge in PDF user-space (origin = bottom-left)
  y: number;         // baseline in PDF user-space
  width: number;
  fontSize: number;
  pageIndex: number;  // 0-based
}

/** Character range [start, end) within one item that must be covered. */
type CharSpan = [number, number];

// ── Text extraction ───────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function extractItems(pdfBuffer: Buffer): Promise<PdfItem[]> {
  const uint8 = new Uint8Array(pdfBuffer);

  const pdf = await getDocument({
    data: uint8,
    verbosity: 0,
    disableFontFace: true,
    isEvalSupported: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    standardFontDataUrl: undefined as any,
  }).promise;

  const items: PdfItem[] = [];

  for (let pn = 1; pn <= pdf.numPages; pn++) {
    const page = await pdf.getPage(pn);
    const tc = await page.getTextContent({ includeMarkedContent: false });

    for (const raw of tc.items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = raw as any;
      const str: string = (item.str ?? '').replace(/\s+/g, ' ').trim();
      if (!str) continue;

      const [a = 10, b = 0, , , e = 0, f = 0]: number[] = item.transform ?? [];
      const fontSize = Math.abs(Math.sqrt(a * a + b * b)) || 10;
      const width: number =
        typeof item.width === 'number' && item.width > 0
          ? item.width
          : fontSize * str.length * 0.55;

      items.push({ str, strNorm: norm(str), x: e, y: f, width, fontSize, pageIndex: pn - 1 });
    }
  }

  logger.info(`Extracted ${items.length} text items from ${pdf.numPages} page(s)`);
  return items;
}

// ── Line grouping ─────────────────────────────────────────────────────────────
// Items are clustered per page by y-proximity (gap ≤ Y_TOL), which is robust
// against baselines that straddle a rounding boundary.

const Y_TOL = 3;

interface Line {
  items: PdfItem[];  // sorted left→right
  concat: string;    // normalised join of all item strings (space-separated)
}

function buildLines(items: PdfItem[]): Line[] {
  const byPage = new Map<number, PdfItem[]>();
  for (const item of items) {
    const list = byPage.get(item.pageIndex) ?? [];
    list.push(item);
    byPage.set(item.pageIndex, list);
  }

  const lines: Line[] = [];
  for (const pageItems of byPage.values()) {
    const sorted = pageItems.slice().sort((a, b) => b.y - a.y || a.x - b.x);

    let cluster: PdfItem[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const lineItems = cluster.slice().sort((a, b) => a.x - b.x);
      lines.push({
        items: lineItems,
        concat: lineItems.map((i) => i.strNorm).join(' '),
      });
      cluster = [];
    };

    for (const item of sorted) {
      if (cluster.length > 0 && Math.abs(cluster[cluster.length - 1].y - item.y) > Y_TOL) {
        flush();
      }
      cluster.push(item);
    }
    flush();
  }
  return lines;
}

// ── Span collection ───────────────────────────────────────────────────────────

/** Accumulates the character ranges to mask, per item. */
class SpanCollector {
  private spans = new Map<PdfItem, CharSpan[]>();

  add(item: PdfItem, start: number, end: number): void {
    const s = Math.max(0, start);
    const e = Math.min(item.str.length, end);
    if (e <= s) return;
    const list = this.spans.get(item) ?? [];
    list.push([s, e]);
    this.spans.set(item, list);
  }

  addWhole(item: PdfItem): void {
    this.add(item, 0, item.str.length);
  }

  get size(): number {
    return this.spans.size;
  }

  /** Merged, sorted spans per item. */
  merged(): Array<{ item: PdfItem; spans: CharSpan[] }> {
    const out: Array<{ item: PdfItem; spans: CharSpan[] }> = [];
    for (const [item, raw] of this.spans) {
      const sorted = raw.slice().sort((a, b) => a[0] - b[0]);
      const merged: CharSpan[] = [];
      for (const [s, e] of sorted) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
      }
      out.push({ item, spans: merged });
    }
    return out;
  }
}

// ── Character-width estimation ────────────────────────────────────────────────
// Helvetica AFM widths (1/1000 em). Exact glyph metrics of the embedded font
// are unavailable through pdf.js textContent, but RELATIVE proportions are
// similar across common text faces, and positions are normalised against the
// item's true total width — so the residual error stays well under a character.

const CHAR_W: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722,
  'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778, 'P': 667,
  'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944, 'X': 667,
  'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556, 'h': 556,
  'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556, 'p': 556,
  'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722, 'x': 500,
  'y': 500, 'z': 500,
};
const DIGIT_W = 556;
const DEFAULT_W = 556;

function charWidth(ch: string): number {
  if (ch >= '0' && ch <= '9') return DIGIT_W;
  return CHAR_W[ch] ?? DEFAULT_W;
}

/**
 * Cumulative x-offsets (in PDF units) for each character boundary of an item:
 * result[i] = distance from item.x to the LEFT edge of character i;
 * result[str.length] = item.width.
 */
function charOffsets(item: PdfItem): number[] {
  const rel: number[] = [0];
  let sum = 0;
  for (const ch of item.str) {
    sum += charWidth(ch);
    rel.push(sum);
  }
  const scale = sum > 0 ? item.width / sum : 0;
  return rel.map((r) => r * scale);
}

/** Every occurrence of `needle` in `haystack` (already normalised). */
function allOccurrences(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    hits.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return hits;
}

/** Stage 2: locate `valueNorm` in the line concat and clip it into per-item ranges. */
function collectLineMatches(line: Line, valueNorm: string, collector: SpanCollector): boolean {
  const positions = allOccurrences(line.concat, valueNorm);
  if (positions.length === 0) return false;

  for (const pos of positions) {
    const end = pos + valueNorm.length;
    let offset = 0;
    for (const item of line.items) {
      const itemStart = offset;
      const itemEnd = offset + item.strNorm.length;
      if (itemEnd > pos && itemStart < end) {
        // Clip the occurrence to this item's own character space
        collector.add(item, pos - itemStart, end - itemStart);
      }
      offset = itemEnd + 1; // +1 for the joining space in concat
    }
  }
  return true;
}

// ── Main redaction export ─────────────────────────────────────────────────────

export async function redactPdf(
  pdfBuffer: Buffer,
  sensitiveValues: string[]
): Promise<Buffer> {
  const values = [...new Set(sensitiveValues.filter((v) => v && v.trim().length > 1))];
  logger.info(`Redacting PDF: ${values.length} sensitive value(s) to mask`);

  // Extract and normalise all text items
  const allItems = await extractItems(pdfBuffer);
  const lines = buildLines(allItems);

  // Load with pdf-lib for drawing
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.CourierBold);

  const collector = new SpanCollector();
  let unmatched = 0;

  for (const value of values) {
    const vNorm = norm(value);
    if (!vNorm) continue;

    let found = false;

    // Stage 1: value occurs inside a single text item — mask just that range
    for (const item of allItems) {
      for (const pos of allOccurrences(item.strNorm, vNorm)) {
        collector.add(item, pos, pos + vNorm.length);
        found = true;
      }
    }

    // Stage 2: value spans multiple adjacent items on the same visual line
    for (const line of lines) {
      // Skip pure single-item lines — stage 1 already covered them
      if (line.items.length > 1 && collectLineMatches(line, vNorm, collector)) {
        found = true;
      }
    }

    // Stage 3: numeric-token fallback for values split ACROSS baselines
    // (e.g. "~USD" and "11.75M/MW" rendered on different lines of a wrapped
    // table cell). Masks only the digit-bearing tokens of the value.
    if (!found) {
      const tokens = vNorm.split(/\s+/).filter((t) => t.length > 2 && /\d/.test(t));
      for (const token of tokens) {
        for (const item of allItems) {
          for (const pos of allOccurrences(item.strNorm, token)) {
            collector.add(item, pos, pos + token.length);
            found = true;
          }
        }
        if (found) {
          logger.info(`  Stage 3 sub-token "${token}" matched for "${value}"`);
          break;
        }
      }
    }

    if (found) {
      logger.info(`  "${value}" → matched`);
    } else {
      unmatched++;
      logger.warn(`  "${value}" → NO MATCH FOUND in PDF text stream`);
    }
  }

  // ── Draw one redaction bar per merged span ──────────────────────────────────
  let totalRedacted = 0;

  for (const { item, spans } of collector.merged()) {
    const page = pages[item.pageIndex];
    if (!page) continue;

    const len = item.str.length || 1;
    const offsets = charOffsets(item);
    const avgCharW = item.width / len;

    for (const [start, end] of spans) {
      // Width-aware x-interpolation with ~0.35 char padding on each side to
      // absorb metric mismatch with the embedded font. Clamped to the item's
      // own box so a partial bar can never spill over neighbouring text.
      const isWhole = start <= 0 && end >= len;
      const pad = isWhole ? 0 : avgCharW * 0.35;

      const bx = Math.max(item.x, item.x + offsets[start] - pad);
      const bw = Math.min(item.x + item.width, item.x + offsets[end] + pad) - bx;

      // Vertical extent hugs the actual glyph box: from just under the
      // descender (baseline − 0.24 em) to just over the ascender/cap height
      // (baseline + 0.92 em). Total ≈ 1.16 em — stays inside normal line
      // spacing so the bar never bleeds into the line above or below.
      const by = item.y - item.fontSize * 0.24;
      const bh = item.fontSize * 1.16;

      // Dark-grey redaction bar (like government document redaction)
      page.drawRectangle({
        x: bx, y: by, width: bw, height: bh,
        color: rgb(0.13, 0.13, 0.13),
        borderWidth: 0,
      });

      // White "XXXX" centred inside the bar (only when it fits)
      const tSize = Math.max(5, Math.min(item.fontSize * 0.70, 10));
      const tW = font.widthOfTextAtSize('XXXX', tSize);
      if (tW <= bw) {
        page.drawText('XXXX', {
          x: bx + (bw - tW) / 2,
          y: by + (bh - tSize) / 2 + 1,
          size: tSize, font, color: rgb(1, 1, 1),
        });
      }

      totalRedacted++;
    }
  }

  logger.info(
    `Redaction complete — ${totalRedacted} bar(s) applied` +
    (unmatched > 0 ? `, ${unmatched} value(s) not found` : '')
  );
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
