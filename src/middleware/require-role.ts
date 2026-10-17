import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../utils/app-error';
import type { Role } from './authenticate';

/** Use after authenticate. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
