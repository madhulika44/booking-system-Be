import { withTransaction } from '../../config/db';
import type { AuthUser } from '../../middleware/authenticate';
import { conflict, notFound, badRequest } from '../../utils/app-error';
import { isForeignKeyViolation } from '../../utils/ownership';
import { offsetOf, type Paginated } from '../../utils/pagination';
import { slugify } from '../../utils/slug';
import { revokeAllRefreshTokensForUser } from '../auth/auth.repository';
import * as categoriesRepo from '../categories/categories.repository';
import * as organizerRepo from '../organizer/organizer.repository';
import type { ManagedEvent } from '../organizer/organizer.repository';
import * as repo from './admin.repository';
import type {
  AdminEventsQuery,
  AdminUsersQuery,
  CreateCategoryInput,
  UpdateCategoryInput,
  UpdateUserInput,
} from './admin.schemas';

// ---------- event approval ----------

export async function listEvents(query: AdminEventsQuery): Promise<Paginated<ManagedEvent>> {
  const { rows, total } = await organizerRepo.listEvents(
    null,
    { status: query.status, q: query.q },
    query.limit,
    offsetOf(query),
  );
  return { data: rows, page: query.page, limit: query.limit, total };
}

/** pending → published | rejected (SPEC §3 lifecycle). The row lock stops double decisions. */
async function decide(eventId: string, decision: 'published' | 'rejected', reason: string | null) {
  await withTransaction(async (client) => {
    const event = await organizerRepo.lockEvent(client, eventId, null);
    if (!event) throw notFound('Event');
    if (event.status !== 'pending') {
      throw conflict(
        'EVENT_NOT_PENDING',
        `Only pending events can be reviewed (this one is ${event.status})`,
      );
    }
    await organizerRepo.setEventStatus(client, eventId, decision, reason);
  });
  return (await organizerRepo.findEvent(eventId, null))!;
}

export const approveEvent = (eventId: string) => decide(eventId, 'published', null);
export const rejectEvent = (eventId: string, reason: string) => decide(eventId, 'rejected', reason);

// ---------- users ----------

export async function listUsers(query: AdminUsersQuery): Promise<Paginated<repo.AdminUser>> {
  const { rows, total } = await repo.listUsers(
    { q: query.q, role: query.role },
    query.limit,
    offsetOf(query),
  );
  return { data: rows, page: query.page, limit: query.limit, total };
}

export async function updateUser(
  admin: AuthUser,
  userId: string,
  input: UpdateUserInput,
): Promise<repo.AdminUser> {
  if (userId === admin.id) {
    throw conflict('CANNOT_MODIFY_SELF', "You can't change your own role or block yourself");
  }
  await withTransaction(async (client) => {
    const user = await repo.findUser(userId, client);
    if (!user) throw notFound('User');
    const isActive = input.isActive ?? user.isActive;
    await repo.updateUser(client, userId, { role: input.role ?? user.role, isActive });
    // Blocking logs the user out everywhere: their refresh tokens stop working immediately
    // (an access token already issued still lives for up to 15 minutes).
    if (!isActive) await revokeAllRefreshTokensForUser(client, userId);
  });
  return (await repo.findUser(userId))!;
}

// ---------- categories ----------

export const listCategories = () => categoriesRepo.listCategoriesWithCounts();

function categoryTaken(err: unknown): never {
  if ((err as { code?: string }).code === '23505') {
    throw conflict('CATEGORY_EXISTS', 'A category with this slug already exists');
  }
  throw err;
}

export async function createCategory(input: CreateCategoryInput) {
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw badRequest('INVALID_SLUG', 'Could not derive a slug from the name; send one');
  return categoriesRepo.insertCategory(input.name, slug).catch(categoryTaken);
}

export async function updateCategory(id: string, input: UpdateCategoryInput) {
  const current = await categoriesRepo.findCategory(id);
  if (!current) throw notFound('Category');
  return categoriesRepo
    .updateCategory(id, input.name ?? current.name, input.slug ?? current.slug)
    .catch(categoryTaken);
}

export async function deleteCategory(id: string): Promise<void> {
  if (!(await categoriesRepo.findCategory(id))) throw notFound('Category');
  try {
    await categoriesRepo.deleteCategory(id);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw conflict('CATEGORY_IN_USE', 'Events use this category, so it cannot be deleted');
    }
    throw err;
  }
}

// ---------- stats ----------

export const getStats = () => repo.getStats();
