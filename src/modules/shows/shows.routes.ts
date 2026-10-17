import { Router } from 'express';
import { optionalAuthenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as controller from './shows.controller';
import { showIdParamsSchema } from './shows.schemas';

export function showsRoutes(): Router {
  const router = Router();
  router.get('/:id', validate({ params: showIdParamsSchema }), controller.getShow);
  // optional auth: lets us flag the caller's own held seats with mine: true
  router.get(
    '/:id/seats',
    optionalAuthenticate,
    validate({ params: showIdParamsSchema }),
    controller.getSeats,
  );
  return router;
}
