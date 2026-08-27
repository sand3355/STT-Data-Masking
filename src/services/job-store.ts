import { MaskingJob, ReviewDecision } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('job-store');
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

const store = new Map<string, MaskingJob>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, job] of store) {
    if (now - job.createdAt > JOB_TTL_MS) {
      store.delete(id);
      logger.debug(`Purged expired job ${id}`);
    }
  }
}

export const jobStore = {
  set(job: MaskingJob): void {
    purgeExpired();
    store.set(job.jobId, job);
    logger.debug(`Stored job ${job.jobId}`);
  },

  get(jobId: string): MaskingJob | undefined {
    return store.get(jobId);
  },

  setDecision(jobId: string, decision: ReviewDecision): boolean {
    const job = store.get(jobId);
    if (!job) return false;
    job.decisions.set(decision.fieldId, decision);
    return true;
  },

  size(): number {
    return store.size;
  },
};
