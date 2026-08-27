import { Router, Request, Response } from 'express';
import { analyseJob, analyseJobStream, applyDecision, applyBulkDecisions } from '../services/masking-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mask-routes');
const router = Router();

function sse(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// GET /api/mask/:jobId/stream — SSE streaming analysis
router.get('/:jobId/stream', async (req: Request, res: Response) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Keepalive so CF router doesn't cut the connection at 90s idle
  const keepalive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);

  const cleanup = () => clearInterval(keepalive);
  req.on('close', cleanup);

  try {
    logger.info(`Stream request for job ${jobId}`);

    const suggestions = await analyseJobStream(jobId, (delta) => {
      sse(res, { type: 'chunk', text: delta });
    });

    sse(res, { type: 'done', suggestions });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    logger.error(`Stream error for ${jobId}`, message);
    sse(res, { type: 'error', message });
  } finally {
    cleanup();
    res.end();
  }
});

// POST /api/mask/:jobId — sync analysis (kept as fallback)
router.post('/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  try {
    logger.info(`Sync mask request for job ${jobId}`);
    const suggestions = await analyseJob(jobId);
    res.json({ jobId, suggestions });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    logger.error(`Mask error for ${jobId}`, message);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// POST /api/mask/:jobId/decisions — record many decisions at once (Mask All / Skip All)
router.post('/:jobId/decisions', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const { decisions } = req.body as { decisions: Array<{ fieldId: string; accepted: boolean }> };

  if (!Array.isArray(decisions)) {
    res.status(400).json({ error: 'Field "decisions" must be an array of { fieldId, accepted }' });
    return;
  }

  try {
    const applied = applyBulkDecisions(
      jobId,
      decisions.filter((d) => d && typeof d.fieldId === 'string' && typeof d.accepted === 'boolean')
    );
    res.json({ jobId, applied });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Bulk decision failed';
    logger.error(`Bulk decision error for ${jobId}`, message);
    res.status(message.includes('not found') ? 404 : 400).json({ error: message });
  }
});

// PATCH /api/mask/:jobId/field/:fieldId — record a review decision
router.patch('/:jobId/field/:fieldId', (req: Request, res: Response) => {
  const { jobId, fieldId } = req.params;
  const { accepted, editedValue } = req.body as { accepted: boolean; editedValue?: string };

  if (typeof accepted !== 'boolean') {
    res.status(400).json({ error: 'Field "accepted" must be boolean' });
    return;
  }

  try {
    applyDecision(jobId, fieldId, accepted, editedValue);
    res.json({ jobId, fieldId, accepted, editedValue });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Decision failed';
    logger.error(`Decision error for ${jobId}/${fieldId}`, message);
    const status = message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

export default router;
