import { Router, Request, Response } from 'express';
import { exportJob } from '../services/masking-service.js';
import { jobStore } from '../services/job-store.js';
import { redactPdf } from '../services/pdf-redactor.js';
import { maskXlsx, maskCsv, maskDocx, maskDocBinary } from '../services/file-masker.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('export-routes');
const router = Router();

// POST /api/export/:jobId — JSON export data used by the review UI stats panel
router.post('/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  try {
    logger.info(`Export JSON request for job ${jobId}`);
    const result = exportJob(jobId);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Export failed';
    logger.error(`Export error for ${jobId}`, message);
    res.status(message.includes('not found') ? 404 : 500).json({ error: message });
  }
});

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

// GET /api/export/:jobId/file — masked document in the SAME format as the upload.
// The original file is edited in place: only sensitive values become XXXX,
// all formatting and other content is preserved.
async function handleFileExport(req: Request, res: Response): Promise<void> {
  const { jobId } = req.params;
  try {
    logger.info(`File export request for job ${jobId}`);

    const job = jobStore.get(jobId);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${jobId}` });
      return;
    }

    let outBuffer: Buffer;

    // If the AI-direct masking path already produced the masked file, serve it
    // immediately — no regeneration needed.
    if (job.maskedBuffer) {
      logger.info(`Serving pre-masked buffer for ${jobId} (${job.maskedBuffer.length} bytes)`);
      outBuffer = job.maskedBuffer;
    } else {
      // Legacy detection-based path: derive values from suggestions and apply maskers
      const exportResult = exportJob(jobId);
      const sensitiveValues = exportResult.auditLog
        .filter((e) => e.finalValue === 'XXXX')
        .map((e) => e.originalValue)
        .filter((v) => v && v.length > 1);

      logger.info(`Detection-based masking: ${sensitiveValues.length} value(s) in ${job.fileType}`);

      switch (job.fileType) {
        case 'pdf':
          outBuffer = await redactPdf(job.originalBuffer, sensitiveValues);
          break;
        case 'xlsx':
          outBuffer = await maskXlsx(job.originalBuffer, sensitiveValues);
          break;
        case 'csv':
          outBuffer = maskCsv(job.originalBuffer, sensitiveValues);
          break;
        case 'docx':
          outBuffer = await maskDocx(job.originalBuffer, sensitiveValues);
          break;
        case 'doc':
          outBuffer = maskDocBinary(job.originalBuffer, sensitiveValues);
          break;
      }
    }

    const safeName = job.fileName.replace(/[^a-z0-9_.-]/gi, '_').replace(/\.[^.]+$/, '');
    res.setHeader('Content-Type', CONTENT_TYPES[job.fileType]);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-masked.${job.fileType}"`);
    res.setHeader('Content-Length', outBuffer.length);
    res.send(outBuffer);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'File generation failed';
    logger.error(`File export error for ${jobId}`, message);
    res.status(500).json({ error: message });
  }
}

router.get('/:jobId/file', handleFileExport);
// Legacy alias — kept so old bookmarks/scripts still work
router.get('/:jobId/pdf', handleFileExport);

export default router;
