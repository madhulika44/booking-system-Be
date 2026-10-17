import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { pool } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { openapiSpec } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createRateLimiters } from './middleware/rate-limit';

export interface AppOptions {
  /** Rate limits are off in tests by default so suites don't trip them. */
  rateLimit?: boolean;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const limiters = createRateLimiters(options.rateLimit ?? !env.isTest);

  // Render sits behind a proxy; needed for correct client IPs (rate limits) and secure cookies
  if (env.isProd) app.set('trust proxy', 1);

  // Swagger UI uses inline scripts, so mount it before helmet's CSP
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
  app.get('/api/docs.json', (_req, res) => res.json(openapiSpec));

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: !env.isTest }));

  const api = Router();

  api.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down', time: new Date().toISOString() });
    }
  });

  void limiters; // module routers are mounted here as phases are added

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
