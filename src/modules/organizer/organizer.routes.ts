import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/require-role';
import { validate } from '../../middleware/validate';
import { venuesRoutes } from '../venues/venues.routes';
import * as controller from './organizer.controller';
import {
  createEventSchema,
  createShowSchema,
  idParamsSchema,
  listEventsQuerySchema,
  showBookingsQuerySchema,
  updateEventSchema,
} from './organizer.schemas';

/** Mounted at /api/organizer. Admins pass the role check and skip ownership filters. */
export function organizerRoutes(): Router {
  const router = Router();
  router.use(authenticate, requireRole('organizer', 'admin'));

  router.use(venuesRoutes());

  const byId = validate({ params: idParamsSchema });

  router.get('/dashboard', controller.dashboard);

  router.get('/events', validate({ query: listEventsQuerySchema }), controller.listEvents);
  router.post('/events', validate({ body: createEventSchema }), controller.createEvent);
  router.get('/events/:id', byId, controller.getEvent);
  router.patch(
    '/events/:id',
    validate({ params: idParamsSchema, body: updateEventSchema }),
    controller.updateEvent,
  );
  router.delete('/events/:id', byId, controller.deleteEvent);
  router.post('/events/:id/submit', byId, controller.submitEvent);

  router.get('/events/:id/shows', byId, controller.listShows);
  router.post(
    '/events/:id/shows',
    validate({ params: idParamsSchema, body: createShowSchema }),
    controller.createShow,
  );
  router.post('/shows/:id/cancel', byId, controller.cancelShow);
  router.get(
    '/shows/:id/bookings',
    validate({ params: idParamsSchema, query: showBookingsQuerySchema }),
    controller.showBookings,
  );
  return router;
}
