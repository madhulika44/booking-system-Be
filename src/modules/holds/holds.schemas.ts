import { z } from 'zod';

const standingItem = z.strictObject({
  zoneId: z.uuid(),
  quantity: z.number().int().min(1).max(6),
});

const seatedItem = z.strictObject({
  zoneId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1).max(6),
});

export const createHoldSchema = z.object({
  showId: z.uuid(),
  // each item is either { zoneId, quantity } (standing) or { zoneId, seatIds } (seated)
  items: z
    .array(z.union([standingItem, seatedItem]))
    .min(1)
    .max(6),
});

export const holdIdParamsSchema = z.object({ id: z.uuid() });

export type CreateHoldInput = z.infer<typeof createHoldSchema>;
