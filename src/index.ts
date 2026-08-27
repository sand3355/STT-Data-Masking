import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { config } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { resolveDeployment } from './services/ai-core-client.js';
import uploadRoutes from './routes/upload-routes.js';
import maskRoutes from './routes/mask-routes.js';
import exportRoutes from './routes/export-routes.js';
import processRoutes from './routes/process-routes.js';

const logger = createLogger('server');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// API routes
app.use('/api/upload', uploadRoutes);
app.use('/api/process', processRoutes);
app.use('/api/mask', maskRoutes);
app.use('/api/export', exportRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve React frontend from built dist
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port}`);
  logger.info(`AI Core endpoint: ${config.aiCore.inferenceUrl}`);

  // Warm up OAuth + deployment discovery so the first upload isn't slow.
  // Failures here are logged but never fatal — the UI surfaces them per-job.
  resolveDeployment()
    .then((d) => logger.info(`AI deployment ready: ${d.id} (${d.model})`))
    .catch((err: unknown) =>
      logger.warn('AI deployment warm-up failed (will retry on first analysis)',
        err instanceof Error ? err.message : String(err))
    );
});
