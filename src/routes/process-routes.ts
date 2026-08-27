import { Router, Request, Response } from 'express';
import { jobStore } from '../services/job-store.js';
import { config } from '../utils/config.js';
import {
  maskDocumentDirectStream, maskRawTextStream, maskSpreadsheetTextStream,
  detectSensitiveValuesInText, planSpreadsheetMasking,
} from '../services/ai-core-client.js';
import {
  maskXlsxFromAiCsv, maskCsvFromAiCsv, createDocxFromText, extractMaskedValuesFromText,
  maskXlsx, maskCsv, maskDocx, maskDocBinary,
  maskXlsxByPlan, maskCsvByPlan, PlanApplyResult,
} from '../services/file-masker.js';
import { analyseDocumentNativeStream } from '../services/ai-core-client.js';
import { redactPdf } from '../services/pdf-redactor.js';
import {
  ProcessStats, MaskingSuggestion, MaskingJob, FieldCategory, Sensitivity, DetectionSource,
  SpreadsheetMaskPlan,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('process-routes');
const router = Router();

// ── Helpers for building suggestions (Track A / B) ───────────────────────────

/**
 * For xlsx/csv: compare rawText (original CSV from xlsx.js) with aiCsv (AI masked output)
 * cell-by-cell to find what was replaced.  Unlike extractMaskedValuesFromText this handles
 * single-character values ("4", "7") that the text-diff helper would filter out.
 */
function extractXlsxDetections(
  rawText: string,
  aiCsv: string
): Array<{ value: string; header: string }> {
  // Proper CSV split: handles quoted fields like "150,000" without breaking on the comma
  const splitRow = (line: string): string[] => {
    const cells: string[] = [];
    let inQuote = false;
    let cell = '';
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells;
  };

  // Strip sheet-marker lines (rawText uses "=== Sheet: X ===" and aiCsv uses "===SHEET:X===")
  const rawLines = rawText.split('\n').filter((l) => !l.trimStart().startsWith('==='));
  const aiLines = aiCsv.split('\n').filter((l) => !l.trimStart().startsWith('==='));

  const headers = rawLines.length > 0 ? splitRow(rawLines[0]) : [];
  const seen = new Set<string>();
  const detections: Array<{ value: string; header: string }> = [];

  const n = Math.min(rawLines.length, aiLines.length);

  // The AI's CSV sometimes carries a leading index column (native spreadsheet
  // view) — detect the constant shift from the header row so values align.
  let shift = 0;
  if (n > 0) {
    const aiHeader = splitRow(aiLines[0]);
    let bestScore = -1;
    for (const s of [0, 1, 2]) {
      let score = 0;
      for (let c = 0; c < headers.length; c++) {
        const a = (aiHeader[c + s] ?? '').trim();
        if (headers[c] !== '' && a.toLowerCase() === headers[c].toLowerCase()) score++;
      }
      if (score > bestScore) { bestScore = score; shift = s; }
    }
  }

  for (let r = 0; r < n; r++) {
    const rawRow = splitRow(rawLines[r]);
    const aiRow = splitRow(aiLines[r]);
    for (let c = 0; c < rawRow.length; c++) {
      const aiVal = aiRow[c + shift] ?? '';
      const origVal = rawRow[c];
      if (aiVal.toUpperCase() === 'XXXX' && origVal && origVal.toUpperCase() !== 'XXXX') {
        if (!seen.has(origVal)) {
          seen.add(origVal);
          detections.push({ value: origVal, header: headers[c] ?? '' });
        }
      }
    }
  }
  return detections;
}

function guessCategoryFromHeader(value: string, header: string): FieldCategory {
  const h = header.toLowerCase();
  if (h.includes('%') || h.includes('weight') || h.includes('percentage') ||
      h.includes('share') || h.includes('ratio') || h.includes('score') || h.includes('rating')) {
    return 'Percentage';
  }
  if (h.includes('vendor') || h.includes('supplier') || h.includes('name') ||
      h.includes('code') || h.includes('company') || h.includes('party')) {
    return 'Vendor Name';
  }
  // Value-level heuristic as fallback
  if (/%/.test(value)) return 'Percentage';
  if (/[$€£¥]|USD|SGD|IDR|MYR|EUR|GBP|CHF|JPY|AUD|\b[MK]\b|MW|GW|KW|[\d,]{5,}/.test(value)) return 'Price';
  return 'Vendor Name';
}

function makeSuggestions(values: string[]): MaskingSuggestion[] {
  return values.map((val, idx) => ({
    fieldId: `auto_${idx + 1}`,
    fieldName: guessCategory(val),
    originalValue: val,
    maskedValue: 'XXXX',
    reason: 'Detected as sensitive data by AI',
    sensitivity: 'high' as Sensitivity,
    source: 'ai' as DetectionSource,
    confidence: 90,
    occurrences: 1,
    verified: true,
    context: '',
  }));
}

function guessCategory(value: string): FieldCategory {
  if (/%/.test(value)) return 'Percentage';
  if (/[$€£¥]|USD|SGD|IDR|MYR|EUR|GBP|CHF|JPY|AUD|\b[MK]\b|MW|GW|KW|[\d,]{5,}/.test(value)) return 'Price';
  return 'Vendor Name';
}

/** Review-page suggestions for plan-based masking: one entry per masked column/value. */
function buildPlanSuggestions(applied: PlanApplyResult): MaskingSuggestion[] {
  const suggestions: MaskingSuggestion[] = [];
  for (const c of applied.columns) {
    suggestions.push({
      fieldId: `plancol_${c.si}_${c.ci}`,
      fieldName: guessCategoryFromHeader('', c.header),
      originalValue: c.sheet
        ? `All values in column "${c.header}" (sheet "${c.sheet}")`
        : `All values in column "${c.header}"`,
      maskedValue: 'XXXX',
      reason: `Entire column masked — ${c.count} value(s)`,
      sensitivity: 'high' as Sensitivity,
      source: 'ai' as DetectionSource,
      confidence: 90,
      occurrences: c.count,
      verified: c.count > 0,
      context: '',
    });
  }
  for (const v of applied.values) {
    suggestions.push({
      fieldId: `planval_${v.si}_${v.vi}`,
      fieldName: guessCategory(v.value),
      originalValue: v.value,
      maskedValue: 'XXXX',
      reason: 'Sensitive value detected outside masked columns',
      sensitivity: 'high' as Sensitivity,
      source: 'ai' as DetectionSource,
      confidence: 90,
      occurrences: v.count,
      verified: v.count > 0,
      context: '',
    });
  }
  for (const s of applied.sweeps) {
    if (s.count === 0) continue;
    suggestions.push({
      fieldId: `plansweep_${s.si}`,
      fieldName: 'Price' as FieldCategory,
      originalValue: s.sheet
        ? `All other amounts & percentages (sheet "${s.sheet}")`
        : 'All other amounts & percentages',
      maskedValue: 'XXXX',
      reason: `Money/percentage-shaped values caught by the numeric sweep — ${s.count} cell(s)`,
      sensitivity: 'high' as Sensitivity,
      source: 'pattern' as DetectionSource,
      confidence: 75,
      occurrences: s.count,
      verified: true,
      context: '',
    });
  }
  return suggestions;
}

// GET /api/process/:jobId/stream
//
// Three-track masking pipeline — ALL MASKING LOGIC UNCHANGED from original:
//
//   Track A — spreadsheets (xlsx, csv):
//     AI reads the binary file natively → outputs full masked CSV.
//     maskXlsxFromAiCsv compares cell-by-cell and updates the original workbook.
//
//   Track B — Word documents (docx, doc):
//     mammoth extracts rawText → AI receives plain text → AI outputs same text
//     with every sensitive value replaced by XXXX → createDocxFromText wraps it.
//
//   Track C — PDF:
//     AI returns JSON detection list → visual redaction bars drawn over matches.
//
// SSE events:  { type: 'chunk', text }  →  { type: 'done', stats, fileName, suggestions }
// The suggestions list drives the review page.  After review the client calls
// POST /:jobId/confirm, then GET /api/export/:jobId/file to download.
// ── Resumable processing state ───────────────────────────────────────────────
// One masking run per job, no matter how many SSE connections attach. When the
// browser's EventSource reconnects after a dropped connection (proxy timeout,
// network blip), the new request attaches to the in-flight run instead of
// re-processing — and if the run already finished it gets the result instantly.
interface ActiveRun {
  promise: Promise<void>;
  listeners: Set<(data: object) => void>;
}
const activeRuns = new Map<string, ActiveRun>();

const HEARTBEAT_INTERVAL_MS = 15_000;

async function runMaskingPipeline(
  job: MaskingJob,
  emit: (data: object) => void
): Promise<void> {
  const jobId = job.jobId;
  try {
    job.status = 'analysing';
    let maskedBuffer: Buffer;
    let maskedCellCount = 0;

    // ── Track A: spreadsheets ──────────────────────────────────────────────────
    if (job.fileType === 'xlsx' || job.fileType === 'csv') {
      const emitDelta = (delta: string) => emit({ type: 'chunk', text: delta });

      // Large spreadsheets: asking the model to re-emit thousands of rows is
      // unreliable (it truncates/summarises), so the AI instead returns a
      // column/value PLAN from headers + sample rows, and the server masks
      // every row mechanically — deterministic at any size.
      if (job.rawText.length > config.limits.maxSinglePassChars) {
        logger.info(`Track A (AI-plan) for ${jobId} (${job.fileType}, ${job.rawText.length} chars)`);
        const plan = await planSpreadsheetMasking(job.rawText, emitDelta);
        job.maskPlan = plan;
        const applied = job.fileType === 'xlsx'
          ? await maskXlsxByPlan(job.originalBuffer, plan)
          : maskCsvByPlan(job.originalBuffer, plan);
        maskedBuffer = applied.buffer;
        maskedCellCount = applied.maskedCount;
        job.suggestions = buildPlanSuggestions(applied);

        job.maskedBuffer = maskedBuffer;
        job.status = 'ready';
        job.maskStats = {
          totalFields: maskedCellCount,
          masked: maskedCellCount,
          skipped: 0,
          pending: 0,
          maskedRate: 100,
          byCategory: [{ category: 'AI-Masked', total: maskedCellCount, masked: maskedCellCount, skipped: 0 }],
        };
        jobStore.set(job);
        logger.info(`Plan masking complete for ${jobId}: ${maskedCellCount} cell(s), ${maskedBuffer.length} bytes`);
        return;
      }

      logger.info(`Track A (AI-CSV) for ${jobId} (${job.fileType})`);
      // Binaries over the document-block payload limit go via extracted text —
      // same prompt and CSV output format, so the cell appliers are unchanged.
      const aiCsv = job.originalBuffer.length > config.limits.maxAiFileBytes
        ? await maskSpreadsheetTextStream(job.rawText, emitDelta)
        : await maskDocumentDirectStream(job.originalBuffer, job.fileType, emitDelta);
      let detections: Array<{ value: string; header: string }>;
      if (job.fileType === 'xlsx') {
        maskedBuffer = await maskXlsxFromAiCsv(job.originalBuffer, aiCsv);
        maskedCellCount = (aiCsv.match(/\bXXXX\b/gi) ?? []).length;
        // Build review suggestions via cell-by-cell comparison (finds single-digit values too)
        detections = extractXlsxDetections(job.rawText, aiCsv);
      } else {
        // CSV: never serve the AI's re-serialized output — it re-flows quoted
        // multi-line cells and inserts sheet markers. Instead, align its rows
        // against the original file and splice XXXX into just the masked cells.
        const result = maskCsvFromAiCsv(job.originalBuffer, aiCsv);
        maskedBuffer = result.buffer;
        maskedCellCount = result.maskedCount;
        detections = result.detections;
      }
      job.suggestions = detections.map((d, idx) => ({
        fieldId: `auto_${idx + 1}`,
        fieldName: guessCategoryFromHeader(d.value, d.header),
        originalValue: d.value,
        maskedValue: 'XXXX',
        reason: 'Detected as sensitive data by AI',
        sensitivity: 'high' as Sensitivity,
        source: 'ai' as DetectionSource,
        confidence: 90,
        occurrences: 1,
        verified: true,
        context: '',
      }));

    // ── Track B: Word documents (AI detects → in-place masking) ───────────────
    } else if (job.fileType === 'docx' || job.fileType === 'doc') {

      // Large docs: full re-emission is unreliable (the model truncates long
      // repetitive output), so detect sensitive VALUES instead (chunked as
      // needed) and apply them to the original binary — works at any size.
      if (job.rawText.length > config.limits.maxSinglePassChars) {
        logger.info(`Track B (AI-detect) for ${jobId} (${job.fileType}, ${job.rawText.length} chars)`);
        const rawSuggestions = await detectSensitiveValuesInText(
          job.rawText,
          (delta) => emit({ type: 'chunk', text: delta })
        );
        const detectedValues = [
          ...new Set(
            rawSuggestions.map((s) => s.originalValue).filter((v) => v && v.trim().length > 1)
          ),
        ];
        job.suggestions = makeSuggestions(detectedValues);
        maskedCellCount = detectedValues.length;
        maskedBuffer = job.fileType === 'docx'
          ? await maskDocx(job.originalBuffer, detectedValues)
          : maskDocBinary(job.originalBuffer, detectedValues);

      } else {
        logger.info(`Track B (AI-direct) for ${jobId} (${job.fileType})`);
        const aiText = await maskRawTextStream(
          job.rawText,
          (delta) => emit({ type: 'chunk', text: delta })
        );

        // Recover WHICH values the AI masked, then edit the ORIGINAL file in
        // place so all formatting, tables, and styles are preserved.
        const detectedValues = extractMaskedValuesFromText(job.rawText, aiText);
        job.suggestions = makeSuggestions(detectedValues);
        maskedCellCount = detectedValues.length;

        if (detectedValues.length > 0) {
          maskedBuffer = job.fileType === 'docx'
            ? await maskDocx(job.originalBuffer, detectedValues)
            : maskDocBinary(job.originalBuffer, detectedValues);
        } else {
          // Value extraction failed but the AI did mask something — fall back to
          // rebuilding the document from the AI's masked text (formatting lost,
          // but nothing sensitive leaks).
          maskedCellCount = (aiText.match(/XXXX/gi) ?? []).length;
          maskedBuffer = await createDocxFromText(aiText);
          job.fileType = 'docx'; // the fallback always produces a .docx
        }
      }

    // ── Track C: PDF (AI returns JSON detection list) ─────────────────────────
    } else if (job.fileType === 'pdf') {
      logger.info(`Track C (AI-JSON) for ${jobId} (pdf)`);

      const rawSuggestions = await analyseDocumentNativeStream(
        job.originalBuffer,
        'pdf',
        job.rawText,
        (delta) => emit({ type: 'chunk', text: delta })
      );

      // Store structured suggestions for the review page
      const seenValues = new Set<string>();
      job.suggestions = rawSuggestions
        .filter((s) => {
          if (!s.originalValue || s.originalValue.trim().length <= 1) return false;
          if (seenValues.has(s.originalValue)) return false;
          seenValues.add(s.originalValue);
          return true;
        })
        .map((s, idx) => {
          const raw = s as unknown as Record<string, unknown>;
          const aiId = typeof raw.fieldId === 'string' ? raw.fieldId.replace(/\W+/g, '_').toLowerCase() : '';
          return {
            fieldId: aiId || `pdf_${idx + 1}`,
            fieldName: s.fieldName,
            originalValue: s.originalValue,
            maskedValue: 'XXXX',
            reason: s.reason || `Detected as ${s.fieldName}`,
            sensitivity: (s.sensitivity || 'high') as Sensitivity,
            source: 'ai' as DetectionSource,
            confidence: 90,
            occurrences: 1,
            verified: true,
            context: '',
          };
        });

      const sensitiveValues = [
        ...new Set(
          rawSuggestions
            .map((s) => s.originalValue)
            .filter((v) => v && v.trim().length > 1)
        ),
      ];

      logger.info(`PDF: ${sensitiveValues.length} value(s) detected`);
      maskedCellCount = sensitiveValues.length;
      maskedBuffer = await redactPdf(job.originalBuffer, sensitiveValues);

    } else {
      throw new Error(`Unsupported file type: ${job.fileType}`);
    }

    // ── Store result ────────────────────────────────────────────────────────
    job.maskedBuffer = maskedBuffer;
    job.status = 'ready';
    job.maskStats = {
      totalFields: maskedCellCount,
      masked: maskedCellCount,
      skipped: 0,
      pending: 0,
      maskedRate: 100,
      byCategory: [{ category: 'AI-Masked', total: maskedCellCount, masked: maskedCellCount, skipped: 0 }],
    };
    jobStore.set(job);

    logger.info(`Masking complete for ${jobId}: ${maskedCellCount} field(s), ${maskedBuffer.length} bytes`);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Processing failed';
    logger.error(`Process error for ${jobId}`, message);
    job.status = 'error';
    job.errorMessage = message;
    jobStore.set(job);
  }
}

router.get('/:jobId/stream', async (req: Request, res: Response) => {
  const { jobId } = req.params;

  // Always answer as an SSE stream — EventSource cannot read the body of a
  // non-200 response, so a plain 404 would surface in the UI as an opaque
  // "Stream connection failed". An in-protocol error event carries a message.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat comment lines keep the connection alive through proxies and
  // routers (CF gorouter, corporate proxies) during silent phases: OAuth,
  // document upload to AI Core, and the non-streaming /converse fallback,
  // which can run for minutes without producing a single byte.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  req.on('close', () => clearInterval(heartbeat));

  const job = jobStore.get(jobId);
  if (!job) {
    send({ type: 'error', message: 'Job not found or expired — please upload the document again.' });
    clearInterval(heartbeat);
    res.end();
    return;
  }

  const sendFinal = () => {
    if (job.status === 'ready' && job.maskStats) {
      send({ type: 'done', stats: job.maskStats, fileName: job.fileName, suggestions: job.suggestions });
    } else {
      send({ type: 'error', message: job.errorMessage ?? 'Processing failed' });
    }
  };

  let run = activeRuns.get(jobId);

  // Reconnect after the run already finished → replay the stored result.
  if (!run && (job.status === 'ready' || job.status === 'error')) {
    logger.info(`Stream reconnect for ${jobId}: replaying stored ${job.status} result`);
    sendFinal();
    clearInterval(heartbeat);
    res.end();
    return;
  }

  if (!run) {
    // First connection for this job → start the masking run exactly once.
    const listeners = new Set<(data: object) => void>();
    const emit = (data: object) => listeners.forEach((l) => l(data));
    run = {
      listeners,
      promise: runMaskingPipeline(job, emit).finally(() => activeRuns.delete(jobId)),
    };
    activeRuns.set(jobId, run);
  } else {
    logger.info(`Stream reconnect for ${jobId}: attaching to in-flight run`);
  }

  run.listeners.add(send);
  try {
    await run.promise;
    sendFinal();
  } finally {
    run.listeners.delete(send);
    clearInterval(heartbeat);
    res.end();
  }
});

// POST /api/process/:jobId/confirm
//
// Called after the user reviews and confirms on the review page.
//
// KEY DESIGN: if the user accepted everything (the default), we serve the ORIGINAL
// AI-produced maskedBuffer unchanged — same quality as the old direct-download flow.
// Only when the user explicitly rejects specific items do we re-run masking from
// the original file, applying only the accepted values.
router.post('/:jobId/confirm', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const { decisions } = req.body as { decisions?: Array<{ fieldId: string; accepted: boolean }> };

  const job = jobStore.get(jobId);
  if (!job) {
    res.status(404).json({ error: `Job not found: ${jobId}` });
    return;
  }

  // Build a decision map; missing entry means "accepted" (mask by default)
  const decisionMap = new Map<string, boolean>();
  if (Array.isArray(decisions)) {
    for (const d of decisions) {
      if (typeof d.fieldId === 'string' && typeof d.accepted === 'boolean') {
        decisionMap.set(d.fieldId, d.accepted);
      }
    }
  }

  // Count rejections
  const rejectedFieldIds = new Set(
    [...decisionMap.entries()].filter(([, accepted]) => !accepted).map(([id]) => id)
  );

  // Build per-category stats
  const byCat = new Map<string, { category: string; total: number; masked: number; skipped: number }>();
  for (const s of job.suggestions) {
    const cat = byCat.get(s.fieldName) ?? { category: s.fieldName, total: 0, masked: 0, skipped: 0 };
    cat.total++;
    if (!rejectedFieldIds.has(s.fieldId)) cat.masked++;
    else cat.skipped++;
    byCat.set(s.fieldName, cat);
  }

  const total = job.suggestions.length;
  const skipped = rejectedFieldIds.size;
  const masked = total - skipped;

  // ── Fast path: nothing rejected → serve the original AI-masked buffer unchanged ──
  // This preserves 100% of the original masking quality (maskXlsxFromAiCsv,
  // createDocxFromText, redactPdf) without any re-processing.
  if (rejectedFieldIds.size === 0) {
    logger.info(`Confirm ${jobId}: all accepted, serving original maskedBuffer`);
    const stats: ProcessStats = {
      totalFields: total,
      masked: total,
      skipped: 0,
      pending: 0,
      maskedRate: 100,
      byCategory: [...byCat.values()],
    };
    res.json({ ok: true, stats });
    return;
  }

  // ── Plan-based jobs (large spreadsheets): re-apply the plan minus rejects ──
  if (job.maskPlan && (job.fileType === 'xlsx' || job.fileType === 'csv')) {
    const filtered: SpreadsheetMaskPlan = {
      sheets: job.maskPlan.sheets.map((s, si) => ({
        name: s.name,
        maskColumns: s.maskColumns.filter((_, ci) => !rejectedFieldIds.has(`plancol_${si}_${ci}`)),
        maskValues: s.maskValues.filter((_, vi) => !rejectedFieldIds.has(`planval_${si}_${vi}`)),
        sweepNumbers: !rejectedFieldIds.has(`plansweep_${si}`),
      })),
    };
    logger.info(`Confirm ${jobId}: plan re-application (${masked} accepted, ${skipped} rejected)`);
    try {
      const applied = job.fileType === 'xlsx'
        ? await maskXlsxByPlan(job.originalBuffer, filtered)
        : maskCsvByPlan(job.originalBuffer, filtered);
      job.maskedBuffer = applied.buffer;
      jobStore.set(job);
      res.json({
        ok: true,
        stats: {
          totalFields: total,
          masked,
          skipped,
          pending: 0,
          maskedRate: total > 0 ? Math.round((masked / total) * 100) : 100,
          byCategory: [...byCat.values()],
        } satisfies ProcessStats,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Confirm masking failed';
      logger.error(`Confirm error for ${jobId}`, message);
      res.status(500).json({ error: message });
    }
    return;
  }

  // ── Slow path: some items rejected → re-mask from original with accepted values only ──
  const acceptedValues = [
    ...new Set(
      job.suggestions
        .filter((s) => !rejectedFieldIds.has(s.fieldId))
        .map((s) => s.originalValue)
        .filter((v) => v && v.trim().length > 0)
    ),
  ];

  logger.info(`Confirm ${jobId}: ${masked} accepted, ${skipped} rejected — re-masking`);

  try {
    let maskedBuffer: Buffer;

    switch (job.fileType) {
      case 'pdf':
        // redactPdf is the same function used in the original flow — identical quality
        maskedBuffer = await redactPdf(job.originalBuffer, acceptedValues);
        break;
      case 'xlsx':
        // maskXlsx applies accepted values via value/numeric matching on the original workbook
        maskedBuffer = await maskXlsx(job.originalBuffer, acceptedValues);
        break;
      case 'csv':
        maskedBuffer = maskCsv(job.originalBuffer, acceptedValues);
        break;
      case 'docx':
        maskedBuffer = await maskDocx(job.originalBuffer, acceptedValues);
        break;
      case 'doc':
        maskedBuffer = maskDocBinary(job.originalBuffer, acceptedValues);
        break;
      default:
        throw new Error(`Unsupported file type: ${job.fileType}`);
    }

    job.maskedBuffer = maskedBuffer;
    jobStore.set(job);

    const stats: ProcessStats = {
      totalFields: total,
      masked,
      skipped,
      pending: 0,
      maskedRate: total > 0 ? Math.round((masked / total) * 100) : 100,
      byCategory: [...byCat.values()],
    };

    res.json({ ok: true, stats });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Confirm masking failed';
    logger.error(`Confirm error for ${jobId}`, message);
    res.status(500).json({ error: message });
  }
});

export default router;
