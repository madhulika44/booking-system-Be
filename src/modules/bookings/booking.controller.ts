import type { Request, Response } from 'express';
import { badRequest } from '../../utils/app-error';
import {
  idempotencyKeySchema,
  type ConfirmBookingInput,
  type MyBookingsQuery,
} from './booking.schemas';
import * as bookingService from './booking.service';

export async function create(req: Request, res: Response): Promise<void> {
  const key = idempotencyKeySchema.safeParse(req.header('Idempotency-Key'));
  if (!key.success) {
    throw badRequest(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Send an Idempotency-Key header (UUID) with this request',
    );
  }
  const { booking, created } = await bookingService.confirmBooking(
    req.user!.id,
    req.body as ConfirmBookingInput,
    key.data,
  );
  // 201 for a new booking, 200 when replaying an earlier request with the same key
  res.status(created ? 201 : 200).json(booking);
}

export async function get(req: Request, res: Response): Promise<void> {
  res.json(await bookingService.getBooking(req.user!.id, String(req.params.id)));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  res.json(await bookingService.cancelBooking(req.user!.id, String(req.params.id)));
}

export async function listMine(req: Request, res: Response): Promise<void> {
  res.json(
    await bookingService.listMyBookings(req.user!.id, req.query as unknown as MyBookingsQuery),
  );
}
