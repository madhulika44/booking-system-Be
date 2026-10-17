import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import type { RateLimiters } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as controller from './holds.controller';
import { createHoldSchema, holdIdParamsSchema } from './holds.schemas';

export function holdsRoutes(limiters: RateLimiters): Router {
  const router = Router();
  router.use(authenticate);
  router.post('/', limiters.booking, validate({ body: createHoldSchema }), controller.create);
  router.get('/:id', validate({ params: holdIdParamsSchema }), controller.get);
  router.delete(
    '/:id',
    limiters.booking,
    validate({ params: holdIdParamsSchema }),
    controller.release,
  );
  return router;
}
