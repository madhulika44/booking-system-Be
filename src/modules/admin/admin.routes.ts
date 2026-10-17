import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/require-role';
import { validate } from '../../middleware/validate';
import * as controller from './admin.controller';
import {
  adminEventsQuerySchema,
  adminUsersQuerySchema,
  createCategorySchema,
  idParamsSchema,
  rejectEventSchema,
  updateCategorySchema,
  updateUserSchema,
} from './admin.schemas';

/** Mounted at /api/admin */
export function adminRoutes(): Router {
  const router = Router();
  router.use(authenticate, requireRole('admin'));
  const byId = validate({ params: idParamsSchema });

  router.get('/events', validate({ query: adminEventsQuerySchema }), controller.listEvents);
  router.post('/events/:id/approve', byId, controller.approveEvent);
  router.post(
    '/events/:id/reject',
    validate({ params: idParamsSchema, body: rejectEventSchema }),
    controller.rejectEvent,
  );

  router.get('/users', validate({ query: adminUsersQuerySchema }), controller.listUsers);
  router.patch(
    '/users/:id',
    validate({ params: idParamsSchema, body: updateUserSchema }),
    controller.updateUser,
  );

  router.get('/categories', controller.listCategories);
  router.post('/categories', validate({ body: createCategorySchema }), controller.createCategory);
  router.patch(
    '/categories/:id',
    validate({ params: idParamsSchema, body: updateCategorySchema }),
    controller.updateCategory,
  );
  router.delete('/categories/:id', byId, controller.deleteCategory);

  router.get('/stats', controller.stats);
  return router;
}
