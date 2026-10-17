import type { AuthUser } from '../middleware/authenticate';

/**
 * Organizers may only touch their own venues/events/shows; admins may touch any.
 * Repositories take this value and add `($n::uuid IS NULL OR organizer_id = $n)` to their WHERE.
 * A row owned by someone else is therefore "not found" (404), which doesn't leak that it exists.
 */
export const ownerScope = (user: AuthUser): string | null =>
  user.role === 'admin' ? null : user.id;

/** Postgres foreign_key_violation, e.g. deleting a venue that shows still reference. */
export const isForeignKeyViolation = (err: unknown) => (err as { code?: string }).code === '23503';
