import crypto from 'crypto';
import { jobStore } from './job-store.js';
import { parseFile, detectFileType, SupportedType } from './file-parser.js';
import { analyseDocument, analyseDocumentStream, analyseDocumentNativeStream } from './ai-core-client.js';
import { reconcile } from './detection-engine.js';
import {
  MaskingJob, MaskingSuggestion, ExportResult, AuditEntry, ExportStats, CategoryStat,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('masking-service');

const TOOL_NAME = 'Data Masking';
const TOOL_VERSION = '2.0.0';

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createJob(
  buffer: Buffer,
  originalName: string,
  mimeType: string
): Promise<{ jobId: string; fileName: string; fileType: SupportedType; charCount: number }> {
  const fileType = detectFileType(originalName, mimeType);
  const { rawText, sheets } = await parseFile(buffer, fileType);
  const jobId = generateJobId();

  const job: MaskingJob = {
    jobId,
    fileName: originalName,
    fileType,
    status: 'uploaded',
    charCount: rawText.length,
    rawText,
    originalBuffer: buffer,
    documentSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    fileStructure: sheets,
    suggestions: [],
    decisions: new Map(),
    createdAt: Date.now(),
  };

  jobStore.set(job);
  logger.info(`Created job ${jobId} for ${originalName}`);

  return { jobId, fileName: originalName, fileType, charCount: rawText.length };
}

export async function analyseJob(jobId: string): Promise<MaskingSuggestion[]> {
  const job = jobStore.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  job.status = 'analysing';
  logger.info(`Analysing job ${jobId}`);

  // Send the original file to AI natively; rawText is used only by the pattern scanner
  const raw = await analyseDocument(job.rawText); // sync path kept for direct callers
  const suggestions = reconcile(job.rawText, raw);
  job.suggestions = suggestions;
  job.status = 'ready';
  jobStore.set(job);

  logger.info(`Analysis complete for ${jobId}: ${suggestions.length} suggestions`);
  return suggestions;
}

export async function analyseJobStream(
  jobId: string,
  onChunk: (delta: string) => void
): Promise<MaskingSuggestion[]> {
  const job = jobStore.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  job.status = 'analysing';
  logger.info(`Streaming analysis for ${jobId} (native document mode)`);

  // Send the original file bytes — Claude reads it with full visual/layout fidelity.
  // rawText is kept as the fallback text and as input for the pattern scanner.
  const raw = await analyseDocumentNativeStream(
    job.originalBuffer,
    job.fileType,
    job.rawText,
    onChunk
  );
  const suggestions = reconcile(job.rawText, raw);
  job.suggestions = suggestions;
  job.status = 'ready';
  jobStore.set(job);

  logger.info(`Stream analysis complete for ${jobId}: ${suggestions.length} suggestions`);
  return suggestions;
}

export function applyDecision(
  jobId: string,
  fieldId: string,
  accepted: boolean,
  editedValue?: string
): void {
  const job = jobStore.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const suggestion = job.suggestions.find((s) => s.fieldId === fieldId);
  if (!suggestion) throw new Error(`Field not found: ${fieldId}`);

  jobStore.setDecision(jobId, { fieldId, accepted, editedValue });
  logger.debug(`Decision saved for ${jobId}/${fieldId}`, { accepted, editedValue });
}

/** Record many decisions at once — backs the "Mask All" / "Skip All" buttons. */
export function applyBulkDecisions(
  jobId: string,
  decisions: Array<{ fieldId: string; accepted: boolean }>
): number {
  const job = jobStore.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  let applied = 0;
  for (const d of decisions) {
    if (!job.suggestions.some((s) => s.fieldId === d.fieldId)) continue;
    jobStore.setDecision(jobId, { fieldId: d.fieldId, accepted: d.accepted });
    applied++;
  }
  logger.info(`Bulk decisions for ${jobId}: ${applied}/${decisions.length} applied`);
  return applied;
}

export function exportJob(jobId: string): ExportResult {
  const job = jobStore.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const auditLog: AuditEntry[] = [];
  const replacements: Array<{ original: string; masked: string }> = [];
  let masked = 0;
  let skipped = 0;
  let pending = 0;
  const byCategory = new Map<string, CategoryStat>();
  const now = new Date().toISOString();

  for (const suggestion of job.suggestions) {
    const decision = job.decisions.get(suggestion.fieldId);
    let finalValue: string;
    let action: AuditEntry['action'];

    if (!decision) {
      // Unreviewed → mask by default (safe choice for a redaction tool)
      finalValue = 'XXXX';
      action = 'pending';
      pending++;
    } else if (!decision.accepted) {
      // Explicitly skipped → keep original (do not add to replacements)
      finalValue = suggestion.originalValue;
      action = 'skipped';
      skipped++;
    } else {
      finalValue = 'XXXX';
      action = 'masked';
      masked++;
    }

    // Only replace when we're actually masking
    if (finalValue === 'XXXX') {
      replacements.push({ original: suggestion.originalValue, masked: 'XXXX' });
    }

    const cat = byCategory.get(suggestion.fieldName) ?? {
      category: suggestion.fieldName, total: 0, masked: 0, skipped: 0,
    };
    cat.total++;
    if (finalValue === 'XXXX') cat.masked++;
    else cat.skipped++;
    byCategory.set(suggestion.fieldName, cat);

    auditLog.push({
      fieldId: suggestion.fieldId,
      fieldName: suggestion.fieldName,
      originalValue: suggestion.originalValue,
      finalValue,
      action,
      reason: suggestion.reason,
      sensitivity: suggestion.sensitivity,
      source: suggestion.source,
      confidence: suggestion.confidence,
      occurrences: suggestion.occurrences,
      timestamp: now,
    });
  }

  // Apply replacements to document text
  let maskedDocument = job.rawText;
  for (const { original, masked: m } of replacements) {
    maskedDocument = maskedDocument.split(original).join(m);
  }

  const total = job.suggestions.length;
  const stats: ExportStats = {
    totalFields: total,
    masked,
    skipped,
    pending,
    maskedRate: total > 0 ? Math.round(((masked + pending) / total) * 100) : 0,
    byCategory: [...byCategory.values()],
  };

  job.status = 'exported';
  jobStore.set(job);

  logger.info(`Export complete for ${jobId}`, { total, masked, skipped, pending });
  return {
    maskedDocument,
    auditLog,
    stats,
    meta: {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      jobId: job.jobId,
      fileName: job.fileName,
      fileType: job.fileType,
      documentSha256: job.documentSha256,
      generatedAt: now,
    },
  };
}
