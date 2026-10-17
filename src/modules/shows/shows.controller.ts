import type { Request, Response } from 'express';
import * as showsService from './shows.service';

export async function getShow(req: Request, res: Response): Promise<void> {
  res.json(await showsService.getShow(String(req.params.id)));
}

export async function getSeats(req: Request, res: Response): Promise<void> {
  res.json(await showsService.getSeatMap(String(req.params.id), req.user?.id ?? null));
}
