import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as controller from './venues.controller';
import {
  createVenueSchema,
  layoutIdParamsSchema,
  layoutSchema,
  updateVenueSchema,
  venueIdParamsSchema,
} from './venues.schemas';

/** Mounted inside the /api/organizer router (auth + role already applied). */
export function venuesRoutes(): Router {
  const router = Router();
  const venueId = validate({ params: venueIdParamsSchema });
  const layoutId = validate({ params: layoutIdParamsSchema });

  router.get('/venues', controller.list);
  router.post('/venues', validate({ body: createVenueSchema }), controller.create);
  router.get('/venues/:id', venueId, controller.get);
  router.patch(
    '/venues/:id',
    validate({ params: venueIdParamsSchema, body: updateVenueSchema }),
    controller.update,
  );
  router.delete('/venues/:id', venueId, controller.remove);

  router.get('/venues/:id/layouts', venueId, controller.listLayouts);
  router.post(
    '/venues/:id/layouts',
    validate({ params: venueIdParamsSchema, body: layoutSchema }),
    controller.createLayout,
  );
  router.get('/layouts/:id', layoutId, controller.getLayout);
  router.put(
    '/layouts/:id',
    validate({ params: layoutIdParamsSchema, body: layoutSchema }),
    controller.replaceLayout,
  );
  router.delete('/layouts/:id', layoutId, controller.removeLayout);
  return router;
}
