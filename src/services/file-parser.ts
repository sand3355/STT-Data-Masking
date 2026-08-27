import * as XLSX from 'xlsx';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { SheetData } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('file-parser');

export type SupportedType = 'xlsx' | 'csv' | 'pdf' | 'docx' | 'doc';

export function detectFileType(originalName: string, mimeType: string): SupportedType {
  const ext = originalName.split('.').pop()?.toLowerCase();
  if (ext === 'xlsx' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (ext === 'csv' || mimeType === 'text/csv') return 'csv';
  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'doc' || mimeType === 'application/msword') return 'doc';
  throw new Error(`Unsupported file type: ${ext || mimeType}`);
}

// Returns both the flat text (for AI) and the structured sheet data (for PDF rendering)
export function parseExcelFull(buffer: Buffer): { rawText: string; sheets: SheetData[] } {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const textLines: string[] = [];
  const sheets: SheetData[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];

    // Flat CSV text for AI
    textLines.push(`=== Sheet: ${sheetName} ===`);
    textLines.push(XLSX.utils.sheet_to_csv(sheet, { blankrows: false }));

    // Structured array-of-arrays for PDF table rendering
    const raw = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,   // format numbers/dates as strings
    });

    const rows = (raw as unknown[][]).map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
    );

    const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    // Pad all rows to the same width
    for (const row of rows) {
      while (row.length < colCount) row.push('');
    }

    sheets.push({ name: sheetName, rows, colCount });
  }

  return { rawText: textLines.join('\n'), sheets };
}

// Run pdf.js synchronously on the Node.js main thread (no web worker).
(GlobalWorkerOptions as { workerSrc: string }).workerSrc = '';

// Extract text with pdfjs-dist, reconstructing lines by grouping items that
// share a baseline y-coordinate. Same engine the redactor uses, so the text
// the AI sees matches what the redactor can find again.
async function parsePdf(buffer: Buffer): Promise<string> {
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const Y_TOL = 3;
  const pageTexts: string[] = [];

  for (let pn = 1; pn <= pdf.numPages; pn++) {
    const page = await pdf.getPage(pn);
    const tc = await page.getTextContent({ includeMarkedContent: false });

    interface Frag { str: string; x: number; y: number; }
    const frags: Frag[] = [];
    for (const raw of tc.items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = raw as any;
      const str: string = (item.str ?? '').trim();
      if (!str) continue;
      const [, , , , x = 0, y = 0]: number[] = item.transform ?? [];
      frags.push({ str, x, y });
    }

    // Group into lines by rounded y, then order: top-to-bottom, left-to-right
    const lines = new Map<number, Frag[]>();
    for (const f of frags) {
      const key = Math.round(f.y / Y_TOL) * Y_TOL;
      const line = lines.get(key) ?? [];
      line.push(f);
      lines.set(key, line);
    }
    const ordered = [...lines.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF origin is bottom-left → higher y first
      .map(([, line]) => line.sort((a, b) => a.x - b.x).map((f) => f.str).join(' '));

    pageTexts.push(ordered.join('\n'));
  }

  return pageTexts.join('\n\n');
}

async function parseWord(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  if (result.messages.length > 0) logger.debug('Mammoth messages', result.messages);
  return result.value;
}

// Legacy binary .doc (Word 97–2003)
// Try mammoth first (more reliable); fall back to word-extractor.
// Both are wrapped so a crash in the extractor returns '' rather than killing the server.
// The .doc buffer is sent directly to Claude for masking, so rawText is only used by
// extractMaskedValuesFromText — an empty string is safe (produces no replacements).
async function parseLegacyDoc(buffer: Buffer): Promise<string> {
  // Attempt 1: mammoth (handles many .doc files)
  try {
    const result = await mammoth.extractRawText({ buffer });
    if (result.value && result.value.trim().length > 10) {
      logger.info(`parseLegacyDoc: mammoth extracted ${result.value.length} chars`);
      return result.value;
    }
  } catch (e) {
    logger.warn('parseLegacyDoc: mammoth failed', e instanceof Error ? e.message : String(e));
  }

  // Attempt 2: word-extractor (OLE reader)
  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    const text = [doc.getHeaders(), doc.getBody(), doc.getFooters()]
      .filter((s) => s && s.trim())
      .join('\n');
    logger.info(`parseLegacyDoc: word-extractor extracted ${text.length} chars`);
    return text;
  } catch (e) {
    logger.warn('parseLegacyDoc: word-extractor failed', e instanceof Error ? e.message : String(e));
  }

  logger.warn('parseLegacyDoc: all extractors failed, returning empty string');
  return '';
}

export async function parseFile(
  buffer: Buffer,
  fileType: SupportedType
): Promise<{ rawText: string; sheets: SheetData[] }> {
  logger.info(`Parsing ${fileType} file, size=${buffer.length} bytes`);
  let rawText: string;
  let sheets: SheetData[] = [];

  switch (fileType) {
    case 'xlsx': {
      const result = parseExcelFull(buffer);
      rawText = result.rawText;
      sheets = result.sheets;
      break;
    }
    case 'csv':
      // Plain text — strip BOM so detection sees clean content
      rawText = buffer.toString('utf8').replace(/^\uFEFF/, '');
      break;
    case 'pdf':
      rawText = await parsePdf(buffer);
      break;
    case 'docx':
      rawText = await parseWord(buffer);
      break;
    case 'doc':
      rawText = await parseLegacyDoc(buffer);
      break;
  }

  const trimmed = rawText.trim();
  logger.info(`Parsed ${trimmed.length} chars from ${fileType}, ${sheets.length} sheets`);
  return { rawText: trimmed, sheets };
}
