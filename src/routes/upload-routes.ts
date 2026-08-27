import { Router, Request, Response } from 'express';
import multer from 'multer';
import { config } from '../utils/config.js';
import { createJob } from '../services/masking-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('upload-routes');
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (allowed.includes(file.mimetype) || ['xlsx', 'csv', 'pdf', 'docx', 'doc'].includes(ext || '')) {
      cb(null, true);
    } else {
      cb(new Error(
        `Unsupported file type: ${file.mimetype || ext}. ` +
        'Supported: .xlsx, .csv, .pdf, .docx, .doc'
      ));
    }
  },
});

// upload.single is invoked manually so multer errors (unsupported type, size
// limit) come back as clean JSON instead of an HTML 500 stack trace
router.post('/', (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload rejected';
      logger.warn('Upload rejected', message);
      res.status(400).json({ error: message });
      return;
    }

    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      logger.info(`Upload received: ${req.file.originalname} (${req.file.size} bytes)`);

      const result = await createJob(req.file.buffer, req.file.originalname, req.file.mimetype);

      res.status(201).json(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Upload failed';
      logger.error('Upload error', message);
      res.status(400).json({ error: message });
    }
  });
});

export default router;
