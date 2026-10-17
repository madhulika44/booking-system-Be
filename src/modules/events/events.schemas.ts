import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination';

const optionalText = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => v || undefined);

export const listEventsQuerySchema = paginationSchema
  .extend({
    q: optionalText,
    category: optionalText, // category slug
    city: optionalText,
    from: z.coerce.date().optional(), // show starts at or after (ISO date/datetime)
    to: z.coerce.date().optional(), // show starts at or before
    minPrice: z.coerce.number().int().min(0).optional(), // paise
    maxPrice: z.coerce.number().int().min(0).optional(), // paise
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: '"from" must be before "to"',
    path: ['to'],
  })
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, {
    message: '"minPrice" must not exceed "maxPrice"',
    path: ['maxPrice'],
  });

export const eventSlugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
});

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
