import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './src/server/db/index.js';
import { getPool } from './src/db/index.js';
import { apiRouter } from './src/server/routes/api.js';
import { setupSocketServer } from './src/server/realtime/socket.js';
import { getUploadsDirPath } from './src/server/storage/upload.js';
import { getCloudMediaFromPostgres } from './src/db/repository.js';

async function startServer() {
  // Initialize PostgreSQL (Neon / DATABASE_URL) as sole runtime database.
  try {
    await initDatabase();
  } catch (err: any) {
    console.error('[Fatal] تعذر بدء الخادم لعدم توفر اتصال قاعدة البيانات PostgreSQL (DATABASE_URL):', err?.message || err);
    process.exit(1);
  }

  const app = express();
  const httpServer = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  // Middlewares
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(cookieParser());

  // Serve uploaded media files with persistent Firebase Storage / PostgreSQL fallback
  const uploadsPath = getUploadsDirPath();
  app.use('/uploads', express.static(uploadsPath));
  app.get('/uploads/:filename', async (req, res) => {
    try {
      const filename = path.basename(req.params.filename);

      const pgFile = await getCloudMediaFromPostgres(filename);
      if (pgFile) {
        if (pgFile.firebaseUrl && pgFile.firebaseUrl.startsWith('http')) {
          return res.redirect(302, pgFile.firebaseUrl);
        }
        if (pgFile.dataBase64) {
          const buf = Buffer.from(pgFile.dataBase64, 'base64');
          res.setHeader('Content-Type', pgFile.mimeType || 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.send(buf);
        }
      }

      const pool = getPool();
      const fallbackRow = await pool.query(
        'SELECT mime_type, data_base64 FROM uploaded_files WHERE filename = $1 LIMIT 1',
        [filename]
      );
      if (fallbackRow.rows[0]?.data_base64) {
        const buf = Buffer.from(fallbackRow.rows[0].data_base64, 'base64');
        res.setHeader('Content-Type', fallbackRow.rows[0].mime_type || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(buf);
      }
    } catch (err) {
      console.error('[Media Serve] Error serving media file:', err);
    }
    res.status(404).end();
  });

  // Mount REST API
  app.use('/api', apiRouter);

  // Setup Socket.IO Real-Time Server
  setupSocketServer(httpServer);

  // Graceful Shutdown Handler
  const handleShutdown = async (signal: string) => {
    console.log(`[Server] Received ${signal}. Closing PostgreSQL pool cleanly...`);
    try {
      await getPool().end();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void handleShutdown('SIGINT'));
  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));

  // Vite middleware for development or static assets in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Nabd Al-Majalis] Full-Stack Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
