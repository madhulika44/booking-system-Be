import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination';

export const confirmBookingSchema = z.object({
  holdId: z.uuid(),
  payment: z.object({
    method: z.literal('mock'),
    simulate: z.enum(['success', 'failure']).default('success'),
  }),
});

export const idempotencyKeySchema = z.uuid({ message: 'Idempotency-Key header must be a UUID' });

export const bookingIdParamsSchema = z.object({ id: z.uuid() });

export const myBookingsQuerySchema = paginationSchema.extend({
  status: z.enum(['upcoming', 'past']).optional(),
});

export type ConfirmBookingInput = z.infer<typeof confirmBookingSchema>;
export type MyBookingsQuery = z.infer<typeof myBookingsQuerySchema>;
