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
import { authRoutes } from './modules/auth/auth.routes';
import { bookingRoutes, meRoutes } from './modules/bookings/booking.routes';
import { holdsRoutes } from './modules/holds/holds.routes';
import { categoriesRoutes } from './modules/categories/categories.routes';
import { citiesRoutes, eventsRoutes } from './modules/events/events.routes';
import { showsRoutes } from './modules/shows/shows.routes';
import { organizerRoutes } from './modules/organizer/organizer.routes';
import { adminRoutes } from './modules/admin/admin.routes';

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

  api.use('/auth', authRoutes(limiters));
  api.use('/categories', categoriesRoutes());
  api.use('/events', eventsRoutes());
  api.use('/cities', citiesRoutes());
  api.use('/shows', showsRoutes());
  api.use('/holds', holdsRoutes(limiters));
  api.use('/bookings', bookingRoutes(limiters));
  api.use('/me', meRoutes());
  api.use('/organizer', organizerRoutes());
  api.use('/admin', adminRoutes());

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
