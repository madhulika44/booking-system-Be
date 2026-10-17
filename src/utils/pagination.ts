import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Paginated<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

export const offsetOf = ({ page, limit }: Pagination) => (page - 1) * limit;
