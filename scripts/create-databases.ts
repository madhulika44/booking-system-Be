/**
 * Creates the dev and test databases if they don't exist.
 * Connects to the default "postgres" maintenance database using the same credentials.
 * (psql may not be on PATH on Windows, so we do it from Node.)
 */
import 'dotenv/config';
import { Client } from 'pg';

async function ensureDatabase(connectionString: string | undefined, label: string): Promise<void> {
  if (!connectionString) {
    console.log(`${label}: not set, skipping`);
    return;
  }
  const url = new URL(connectionString);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`${label}: unsafe database name "${dbName}"`);
  }

  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount) {
      console.log(`${label}: database "${dbName}" already exists`);
    } else {
      // CREATE DATABASE cannot take bind parameters; the name is validated above.
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`${label}: created database "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await ensureDatabase(process.env.DATABASE_URL, 'DATABASE_URL');
  await ensureDatabase(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
