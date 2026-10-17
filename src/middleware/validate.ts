import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { badRequest } from '../utils/app-error';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

interface Issue {
  location: 'body' | 'query' | 'params';
  path: string;
  message: string;
}

/**
 * Validates and replaces req.body / req.query / req.params with the parsed (typed, defaulted) values.
 * Controllers can then trust the shapes defined in each module's schemas file.
 */
export const validate =
  (schemas: Schemas) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const issues: Issue[] = [];

    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;

      const input: unknown = location === 'body' ? (req.body ?? {}) : req[location];
      const result = schema.safeParse(input);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
        continue;
      }

      // req.query is a read-only getter in Express 5, so redefine all three the same way
      Object.defineProperty(req, location, {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    if (issues.length) {
      return next(badRequest('VALIDATION_ERROR', 'Request validation failed', { issues }));
    }
    next();
  };
