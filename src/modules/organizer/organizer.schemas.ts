import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination';

export const EVENT_STATUSES = ['draft', 'pending', 'published', 'rejected', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const idParamsSchema = z.object({ id: z.uuid() });

export const listEventsQuerySchema = paginationSchema.extend({
  status: z.enum(EVENT_STATUSES).optional(),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
});

const eventFields = {
  title: z.string().trim().min(1).max(150),
  categoryId: z.uuid(),
  description: z.string().trim().max(5000),
  posterUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullable(),
  language: z.string().trim().max(40).nullable(),
  durationMin: z.number().int().min(1).max(1440).nullable(),
};

export const createEventSchema = z.object({
  title: eventFields.title,
  categoryId: eventFields.categoryId,
  description: eventFields.description.default(''),
  posterUrl: eventFields.posterUrl.optional().default(null),
  language: eventFields.language.optional().default(null),
  durationMin: eventFields.durationMin.optional().default(null),
});

/** Either content edits, or { status: 'cancelled' } on its own. */
export const updateEventSchema = z
  .strictObject({
    title: eventFields.title.optional(),
    categoryId: eventFields.categoryId.optional(),
    description: eventFields.description.optional(),
    posterUrl: eventFields.posterUrl.optional(),
    language: eventFields.language.optional(),
    durationMin: eventFields.durationMin.optional(),
    status: z.literal('cancelled').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to update' })
  .refine((v) => v.status === undefined || Object.keys(v).length === 1, {
    message: 'Send { "status": "cancelled" } on its own',
    path: ['status'],
  });

export const createShowSchema = z.object({
  venueId: z.uuid(),
  layoutId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  zonePrices: z
    .array(
      z.object({
        layoutZoneId: z.uuid(),
        pricePaise: z.number().int().min(0).max(10_000_000), // up to ₹1,00,000
      }),
    )
    .min(1)
    .max(10),
});

export const showBookingsQuerySchema = paginationSchema;

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type CreateShowInput = z.infer<typeof createShowSchema>;
