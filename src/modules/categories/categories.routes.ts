import { Router } from 'express';
import * as controller from './categories.controller';

export function categoriesRoutes(): Router {
  const router = Router();
  router.get('/', controller.list);
  return router;
}
