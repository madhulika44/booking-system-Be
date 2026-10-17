import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination';
import { EVENT_STATUSES } from '../organizer/organizer.schemas';

const optionalSearch = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => v || undefined);

export const idParamsSchema = z.object({ id: z.uuid() });

export const adminEventsQuerySchema = paginationSchema.extend({
  status: z.enum(EVENT_STATUSES).optional(),
  q: optionalSearch,
});

export const rejectEventSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});

export const ROLES = ['attendee', 'organizer', 'admin'] as const;

export const adminUsersQuerySchema = paginationSchema.extend({
  q: optionalSearch, // name or email
  role: z.enum(ROLES).optional(),
});

export const updateUserSchema = z
  .strictObject({
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, {
    message: 'Send role and/or isActive',
  });

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may only contain a-z, 0-9 and single dashes')
  .max(60);

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  slug: slug.optional(), // derived from the name when omitted
});

export const updateCategorySchema = createCategorySchema
  .partial()
  .refine((v) => v.name !== undefined || v.slug !== undefined, {
    message: 'Send name and/or slug',
  });

export type AdminEventsQuery = z.infer<typeof adminEventsQuerySchema>;
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
