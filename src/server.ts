import { createApp } from './app';
import { pool } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { startExpireHoldsJob } from './jobs/expire-holds.job';

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info(`TicketHive API listening on http://localhost:${env.port} (docs: /api/docs)`);
});

const stopExpireHoldsJob = startExpireHoldsJob();

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);
  stopExpireHoldsJob();
  server.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
