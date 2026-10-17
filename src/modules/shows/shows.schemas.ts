import { z } from 'zod';

export const showIdParamsSchema = z.object({
  id: z.uuid({ message: 'Show id must be a UUID' }),
});
