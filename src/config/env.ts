import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  throw new Error('Invalid environment variables');
}

const raw = parsed.data;
const isTest = raw.NODE_ENV === 'test';

if (isTest && !raw.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is required when NODE_ENV=test');
}

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  isTest,
  port: raw.PORT,
  // Tests always run against the separate test database
  databaseUrl: isTest ? raw.TEST_DATABASE_URL! : raw.DATABASE_URL,
  jwtAccessSecret: raw.JWT_ACCESS_SECRET,
  accessTokenTtl: raw.ACCESS_TOKEN_TTL,
  refreshTokenTtlDays: raw.REFRESH_TOKEN_TTL_DAYS,
  corsOrigin: raw.CORS_ORIGIN.split(',').map((o) => o.trim()),
};
