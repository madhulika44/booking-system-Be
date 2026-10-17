import { pool, type Queryable } from '../../config/db';
import type { Role } from '../../middleware/authenticate';
import type { User } from '../auth/auth.repository';

export interface AdminUser extends User {
  bookingCount: number;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
  created_at: Date;
  booking_count: number;
}

const toUser = (r: UserRow): AdminUser => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  isActive: r.is_active,
  createdAt: r.created_at,
  bookingCount: r.booking_count,
});

const USER_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
         (SELECT COUNT(*)::int FROM bookings b WHERE b.user_id = u.id) AS booking_count
  FROM users u`;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function listUsers(
  filters: { q?: string; role?: Role },
  limit: number,
  offset: number,
): Promise<{ rows: AdminUser[]; total: number }> {
  const params = [filters.q ? `%${escapeLike(filters.q)}%` : null, filters.role ?? null];
  const where = `
    WHERE ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1)
      AND ($2::text IS NULL OR u.role = $2)`;
  const [data, count] = await Promise.all([
    pool.query<UserRow>(`${USER_SELECT} ${where} ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`, [
      ...params,
      limit,
      offset,
    ]),
    pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM users u ${where}`, params),
  ]);
  return { rows: data.rows.map(toUser), total: count.rows[0]!.total };
}

export async function findUser(id: string, db: Queryable = pool): Promise<AdminUser | undefined> {
  const { rows } = await db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] && toUser(rows[0]);
}

export async function updateUser(
  db: Queryable,
  id: string,
  input: { role: Role; isActive: boolean },
): Promise<void> {
  await db.query('UPDATE users SET role = $2, is_active = $3 WHERE id = $1', [
    id,
    input.role,
    input.isActive,
  ]);
}

export interface PlatformStats {
  users: { total: number; attendees: number; organizers: number; admins: number; blocked: number };
  events: {
    draft: number;
    pending: number;
    published: number;
    rejected: number;
    cancelled: number;
  };
  shows: { upcoming: number; completed: number; cancelled: number };
  bookings: { confirmed: number; cancelled: number };
  ticketsSold: number;
  revenuePaise: number;
}

export async function getStats(): Promise<PlatformStats> {
  const { rows } = await pool.query<{
    users_total: number;
    attendees: number;
    organizers: number;
    admins: number;
    blocked: number;
    ev_draft: number;
    ev_pending: number;
    ev_published: number;
    ev_rejected: number;
    ev_cancelled: number;
    shows_upcoming: number;
    shows_completed: number;
    shows_cancelled: number;
    bookings_confirmed: number;
    bookings_cancelled: number;
    tickets_sold: number;
    revenue_paise: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS users_total,
       (SELECT COUNT(*)::int FROM users WHERE role = 'attendee') AS attendees,
       (SELECT COUNT(*)::int FROM users WHERE role = 'organizer') AS organizers,
       (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admins,
       (SELECT COUNT(*)::int FROM users WHERE NOT is_active) AS blocked,
       (SELECT COUNT(*)::int FROM events WHERE status = 'draft') AS ev_draft,
       (SELECT COUNT(*)::int FROM events WHERE status = 'pending') AS ev_pending,
       (SELECT COUNT(*)::int FROM events WHERE status = 'published') AS ev_published,
       (SELECT COUNT(*)::int FROM events WHERE status = 'rejected') AS ev_rejected,
       (SELECT COUNT(*)::int FROM events WHERE status = 'cancelled') AS ev_cancelled,
       (SELECT COUNT(*)::int FROM shows WHERE status = 'scheduled' AND starts_at > now()) AS shows_upcoming,
       (SELECT COUNT(*)::int FROM shows
        WHERE status = 'completed' OR (status = 'scheduled' AND starts_at <= now())) AS shows_completed,
       (SELECT COUNT(*)::int FROM shows WHERE status = 'cancelled') AS shows_cancelled,
       (SELECT COUNT(*)::int FROM bookings WHERE status = 'confirmed') AS bookings_confirmed,
       (SELECT COUNT(*)::int FROM bookings WHERE status = 'cancelled') AS bookings_cancelled,
       (SELECT COALESCE(SUM(bi.quantity), 0)::int FROM booking_items bi
        JOIN bookings b ON b.id = bi.booking_id WHERE b.status = 'confirmed') AS tickets_sold,
       (SELECT COALESCE(SUM(total_paise), 0)::bigint FROM bookings
        WHERE status = 'confirmed') AS revenue_paise`,
  );
  const r = rows[0]!;
  return {
    users: {
      total: r.users_total,
      attendees: r.attendees,
      organizers: r.organizers,
      admins: r.admins,
      blocked: r.blocked,
    },
    events: {
      draft: r.ev_draft,
      pending: r.ev_pending,
      published: r.ev_published,
      rejected: r.ev_rejected,
      cancelled: r.ev_cancelled,
    },
    shows: {
      upcoming: r.shows_upcoming,
      completed: r.shows_completed,
      cancelled: r.shows_cancelled,
    },
    bookings: { confirmed: r.bookings_confirmed, cancelled: r.bookings_cancelled },
    ticketsSold: r.tickets_sold,
    revenuePaise: Number(r.revenue_paise),
  };
}
