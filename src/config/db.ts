import { Pool, PoolClient } from 'pg';
import { env } from './env';
import { logger } from './logger';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  // Neon (production) requires TLS
  ssl: env.isProd ? { rejectUnauthorized: true } : undefined,
  max: 10,
});

pool.on('error', (err) => logger.error({ err }, 'Unexpected idle Postgres client error'));

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pool | PoolClient;

/**
 * Runs fn inside BEGIN/COMMIT on a single client; ROLLBACK on any error.
 * All inventory changes go through here so they are all-or-nothing.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
