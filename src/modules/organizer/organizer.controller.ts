import type { Request, Response } from 'express';
import type { Pagination } from '../../utils/pagination';
import type {
  CreateEventInput,
  CreateShowInput,
  ListEventsQuery,
  UpdateEventInput,
} from './organizer.schemas';
import * as organizerService from './organizer.service';

const id = (req: Request) => String(req.params.id);

export async function listEvents(req: Request, res: Response): Promise<void> {
  res.json(await organizerService.listEvents(req.user!, req.query as unknown as ListEventsQuery));
}

export async function createEvent(req: Request, res: Response): Promise<void> {
  res.status(201).json(await organizerService.createEvent(req.user!, req.body as CreateEventInput));
}

export async function getEvent(req: Request, res: Response): Promise<void> {
  res.json(await organizerService.getEvent(req.user!, id(req)));
}

export async function updateEvent(req: Request, res: Response): Promise<void> {
  res.json(await organizerService.updateEvent(req.user!, id(req), req.body as UpdateEventInput));
}

export async function deleteEvent(req: Request, res: Response): Promise<void> {
  await organizerService.deleteEvent(req.user!, id(req));
  res.status(204).end();
}

export async function submitEvent(req: Request, res: Response): Promise<void> {
  res.json(await organizerService.submitEvent(req.user!, id(req)));
}

export async function listShows(req: Request, res: Response): Promise<void> {
  res.json({ data: await organizerService.listShows(req.user!, id(req)) });
}

export async function createShow(req: Request, res: Response): Promise<void> {
  res
    .status(201)
    .json(await organizerService.createShow(req.user!, id(req), req.body as CreateShowInput));
}

export async function cancelShow(req: Request, res: Response): Promise<void> {
  res.json(await organizerService.cancelShow(req.user!, id(req)));
}

export async function showBookings(req: Request, res: Response): Promise<void> {
  res.json(
    await organizerService.listShowBookings(req.user!, id(req), req.query as unknown as Pagination),
  );
}

export async function dashboard(req: Request, res: Response): Promise<void> {
  res.json(await organizerService.getDashboard(req.user!));
}
