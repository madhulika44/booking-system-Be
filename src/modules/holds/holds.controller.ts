import type { Request, Response } from 'express';
import * as bookingService from '../bookings/booking.service';
import type { CreateHoldInput } from './holds.schemas';

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await bookingService.createHold(req.user!.id, req.body as CreateHoldInput));
}

export async function get(req: Request, res: Response): Promise<void> {
  res.json(await bookingService.getHold(req.user!.id, String(req.params.id)));
}

export async function release(req: Request, res: Response): Promise<void> {
  await bookingService.releaseHold(req.user!.id, String(req.params.id));
  res.status(204).end();
}
