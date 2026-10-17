import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import type { RateLimiters } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as controller from './booking.controller';
import {
  bookingIdParamsSchema,
  confirmBookingSchema,
  myBookingsQuerySchema,
} from './booking.schemas';

/** Mounted at /api/bookings */
export function bookingRoutes(limiters: RateLimiters): Router {
  const router = Router();
  router.use(authenticate);
  router.post('/', limiters.booking, validate({ body: confirmBookingSchema }), controller.create);
  router.get('/:id', validate({ params: bookingIdParamsSchema }), controller.get);
  router.post(
    '/:id/cancel',
    limiters.booking,
    validate({ params: bookingIdParamsSchema }),
    controller.cancel,
  );
  return router;
}

/** Mounted at /api/me */
export function meRoutes(): Router {
  const router = Router();
  router.use(authenticate);
  router.get('/bookings', validate({ query: myBookingsQuerySchema }), controller.listMine);
  return router;
}
