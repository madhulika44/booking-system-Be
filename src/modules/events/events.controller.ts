import type { Request, Response } from 'express';
import type { ListEventsQuery } from './events.schemas';
import * as eventsService from './events.service';

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await eventsService.listEvents(req.query as unknown as ListEventsQuery));
}

export async function featured(_req: Request, res: Response): Promise<void> {
  res.json({ data: await eventsService.listFeaturedEvents() });
}

export async function getBySlug(req: Request, res: Response): Promise<void> {
  res.json(await eventsService.getEventBySlug(String(req.params.slug)));
}
