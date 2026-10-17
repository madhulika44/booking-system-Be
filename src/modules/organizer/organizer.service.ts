import { withTransaction } from '../../config/db';
import type { AuthUser } from '../../middleware/authenticate';
import { badRequest, conflict, notFound } from '../../utils/app-error';
import { ownerScope } from '../../utils/ownership';
import { offsetOf, type Paginated, type Pagination } from '../../utils/pagination';
import { slugify, uniqueSlug } from '../../utils/slug';
import * as bookingRepo from '../bookings/booking.repository';
import { cancelAllForShow } from '../bookings/booking.service';
import { createShowWithInventory } from '../shows/show-inventory.repository';
import * as venuesRepo from '../venues/venues.repository';
import * as repo from './organizer.repository';
import type { ManagedEvent, ManagedShow } from './organizer.repository';
import type {
  CreateEventInput,
  CreateShowInput,
  EventStatus,
  ListEventsQuery,
  UpdateEventInput,
} from './organizer.schemas';

/** Content can be edited while the event is not yet live (and after a rejection, to fix it). */
const EDITABLE: EventStatus[] = ['draft', 'rejected'];
const SUBMITTABLE: EventStatus[] = ['draft', 'rejected'];

async function requireEvent(user: AuthUser, eventId: string): Promise<ManagedEvent> {
  const event = await repo.findEvent(eventId, ownerScope(user));
  if (!event) throw notFound('Event');
  return event;
}

async function requireCategory(categoryId: string): Promise<void> {
  if (!(await repo.categoryExists(categoryId))) {
    throw badRequest('INVALID_CATEGORY', 'Category does not exist', { categoryId });
  }
}

// ---------- events ----------

export async function listEvents(
  user: AuthUser,
  query: ListEventsQuery,
): Promise<Paginated<ManagedEvent>> {
  const { rows, total } = await repo.listEvents(
    ownerScope(user),
    { status: query.status, q: query.q },
    query.limit,
    offsetOf(query),
  );
  return { data: rows, page: query.page, limit: query.limit, total };
}

export async function getEvent(user: AuthUser, eventId: string) {
  const event = await requireEvent(user, eventId);
  return { ...event, shows: await repo.listShowsForEvent(eventId) };
}

export async function createEvent(user: AuthUser, input: CreateEventInput) {
  await requireCategory(input.categoryId);
  const base = slugify(input.title) || 'event';
  const slug = (await repo.slugExists(base)) ? uniqueSlug(input.title || 'event') : base;
  const id = await repo.insertEvent(user.id, slug, input);
  return getEvent(user, id);
}

export async function updateEvent(user: AuthUser, eventId: string, input: UpdateEventInput) {
  if (input.status === 'cancelled') return cancelEvent(user, eventId);

  const event = await requireEvent(user, eventId);
  if (!EDITABLE.includes(event.status)) {
    throw conflict('EVENT_NOT_EDITABLE', `A ${event.status} event can't be edited`);
  }
  if (input.categoryId) await requireCategory(input.categoryId);

  await repo.updateEventContent(eventId, {
    title: input.title ?? event.title,
    categoryId: input.categoryId ?? event.category.id,
    description: input.description ?? event.description,
    posterUrl: input.posterUrl !== undefined ? input.posterUrl : event.posterUrl,
    language: input.language !== undefined ? input.language : event.language,
    durationMin: input.durationMin !== undefined ? input.durationMin : event.durationMin,
  });
  return getEvent(user, eventId);
}

/** Organizer or admin can cancel an event at any stage; its scheduled shows are cancelled too. */
async function cancelEvent(user: AuthUser, eventId: string) {
  await withTransaction(async (client) => {
    const event = await repo.lockEvent(client, eventId, ownerScope(user));
    if (!event) throw notFound('Event');
    if (event.status === 'cancelled') {
      throw conflict('EVENT_ALREADY_CANCELLED', 'This event is already cancelled');
    }
    await repo.setEventStatus(client, eventId, 'cancelled');
    for (const show of await repo.lockShows(client, { eventId, ownerId: null })) {
      if (show.status !== 'scheduled') continue;
      await repo.setShowStatus(client, show.id, 'cancelled');
      await cancelAllForShow(client, show.id);
    }
  });
  return getEvent(user, eventId);
}

export async function deleteEvent(user: AuthUser, eventId: string): Promise<void> {
  const event = await requireEvent(user, eventId);
  if (event.status !== 'draft') {
    throw conflict('EVENT_NOT_DRAFT', 'Only draft events can be deleted. Cancel it instead.');
  }
  await repo.deleteEvent(eventId);
}

export async function submitEvent(user: AuthUser, eventId: string) {
  await withTransaction(async (client) => {
    const event = await repo.lockEvent(client, eventId, ownerScope(user));
    if (!event) throw notFound('Event');
    if (!SUBMITTABLE.includes(event.status)) {
      throw conflict(
        'EVENT_NOT_SUBMITTABLE',
        `A ${event.status} event can't be submitted for approval`,
      );
    }
    await repo.setEventStatus(client, eventId, 'pending'); // clears any old rejection reason
  });
  return getEvent(user, eventId);
}

// ---------- shows ----------

export async function listShows(user: AuthUser, eventId: string): Promise<ManagedShow[]> {
  await requireEvent(user, eventId);
  return repo.listShowsForEvent(eventId);
}

export async function createShow(
  user: AuthUser,
  eventId: string,
  input: CreateShowInput,
): Promise<ManagedShow> {
  const event = await requireEvent(user, eventId);
  if (event.status === 'cancelled') {
    throw conflict('EVENT_CANCELLED', "Shows can't be added to a cancelled event");
  }
  if (input.startsAt.getTime() <= Date.now()) {
    throw badRequest('SHOW_IN_PAST', 'Show must start in the future');
  }

  // Venue and layout must belong to the event's organizer (also when an admin does this)
  const venue = await venuesRepo.findVenue(input.venueId, event.organizer.id);
  if (!venue) throw notFound('Venue');
  const layout = await venuesRepo.findLayout(input.layoutId, event.organizer.id);
  if (!layout || layout.venueId !== venue.id) {
    throw badRequest('LAYOUT_VENUE_MISMATCH', 'Layout does not belong to this venue');
  }

  // Every zone of the layout needs exactly one price
  const layoutZoneIds = new Set(await repo.listLayoutZoneIds(layout.id));
  const priced = input.zonePrices.map((z) => z.layoutZoneId);
  const missing = [...layoutZoneIds].filter((id) => !priced.includes(id));
  const unknown = priced.filter((id) => !layoutZoneIds.has(id));
  if (missing.length || unknown.length || new Set(priced).size !== priced.length) {
    throw badRequest(
      'ZONE_PRICES_MISMATCH',
      'Give exactly one price for every zone of the layout',
      {
        missing,
        unknown,
      },
    );
  }

  const showId = await withTransaction((client) =>
    createShowWithInventory(client, {
      eventId,
      venueId: venue.id,
      layoutId: layout.id,
      startsAt: input.startsAt,
      zonePrices: input.zonePrices,
    }),
  );
  return (await repo.listShowsForEvent(eventId)).find((s) => s.id === showId)!;
}

export async function cancelShow(user: AuthUser, showId: string) {
  const result = await withTransaction(async (client) => {
    const [show] = await repo.lockShows(client, { showId, ownerId: ownerScope(user) });
    if (!show) throw notFound('Show');
    if (show.status !== 'scheduled') {
      throw conflict('SHOW_NOT_SCHEDULED', `This show is already ${show.status}`);
    }
    await repo.setShowStatus(client, showId, 'cancelled');
    return cancelAllForShow(client, showId);
  });
  const show = (await repo.findShow(showId, null))!;
  return {
    show: (await repo.listShowsForEvent(show.eventId)).find((s) => s.id === showId)!,
    ...result,
  };
}

export async function listShowBookings(user: AuthUser, showId: string, query: Pagination) {
  const show = await repo.findShow(showId, ownerScope(user));
  if (!show) throw notFound('Show');
  const { rows, total } = await bookingRepo.listBookingsForShow(
    showId,
    query.limit,
    offsetOf(query),
  );
  return { show, data: rows, page: query.page, limit: query.limit, total };
}

export const getDashboard = (user: AuthUser) => repo.getDashboard(ownerScope(user));
