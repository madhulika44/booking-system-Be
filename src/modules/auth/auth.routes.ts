import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import type { RateLimiters } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as controller from './auth.controller';
import { loginSchema, registerSchema } from './auth.schemas';

export function authRoutes(limiters: RateLimiters): Router {
  const router = Router();
  router.post('/register', limiters.auth, validate({ body: registerSchema }), controller.register);
  router.post('/login', limiters.auth, validate({ body: loginSchema }), controller.login);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);
  router.get('/me', authenticate, controller.me);
  return router;
}
