import type { Request, Response } from 'express';
import type {
  AdminEventsQuery,
  AdminUsersQuery,
  CreateCategoryInput,
  UpdateCategoryInput,
  UpdateUserInput,
} from './admin.schemas';
import * as adminService from './admin.service';

const id = (req: Request) => String(req.params.id);

export async function listEvents(req: Request, res: Response): Promise<void> {
  res.json(await adminService.listEvents(req.query as unknown as AdminEventsQuery));
}

export async function approveEvent(req: Request, res: Response): Promise<void> {
  res.json(await adminService.approveEvent(id(req)));
}

export async function rejectEvent(req: Request, res: Response): Promise<void> {
  res.json(await adminService.rejectEvent(id(req), (req.body as { reason: string }).reason));
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  res.json(await adminService.listUsers(req.query as unknown as AdminUsersQuery));
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  res.json(await adminService.updateUser(req.user!, id(req), req.body as UpdateUserInput));
}

export async function listCategories(_req: Request, res: Response): Promise<void> {
  res.json({ data: await adminService.listCategories() });
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  res.status(201).json(await adminService.createCategory(req.body as CreateCategoryInput));
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  res.json(await adminService.updateCategory(id(req), req.body as UpdateCategoryInput));
}

export async function deleteCategory(req: Request, res: Response): Promise<void> {
  await adminService.deleteCategory(id(req));
  res.status(204).end();
}

export async function stats(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.getStats());
}
