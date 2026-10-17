import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as controller from './events.controller';
import { eventSlugParamsSchema, listEventsQuerySchema } from './events.schemas';

export function eventsRoutes(): Router {
  const router = Router();
  router.get('/', validate({ query: listEventsQuerySchema }), controller.list);
  // must be registered before /:slug
  router.get('/featured', controller.featured);
  router.get('/:slug', validate({ params: eventSlugParamsSchema }), controller.getBySlug);
  return router;
}

/** Mounted at /api/cities (city selector in the header). */
export function citiesRoutes(): Router {
  const router = Router();
  router.get('/', controller.cities);
  return router;
}
