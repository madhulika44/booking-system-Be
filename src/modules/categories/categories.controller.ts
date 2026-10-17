import type { Request, Response } from 'express';
import * as categoriesService from './categories.service';

export async function list(_req: Request, res: Response): Promise<void> {
  res.json({ data: await categoriesService.listCategories() });
}
