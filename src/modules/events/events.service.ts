import { notFound } from '../../utils/app-error';
import { offsetOf, type Paginated } from '../../utils/pagination';
import * as repo from './events.repository';
import type { ListEventsQuery } from './events.schemas';

const FEATURED_LIMIT = 6;

export async function listEvents(query: ListEventsQuery): Promise<Paginated<repo.EventCard>> {
  const { page, limit, ...filters } = query;
  const { rows, total } = await repo.listEvents(filters, limit, offsetOf({ page, limit }));
  return { data: rows, page, limit, total };
}

export const listFeaturedEvents = () => repo.listFeaturedEvents(FEATURED_LIMIT);

export async function getEventBySlug(slug: string): Promise<repo.EventDetail> {
  const event = await repo.findPublishedEventBySlug(slug);
  if (!event) throw notFound('Event');
  return event;
}

export const listCities = () => repo.listCitiesWithUpcomingShows();
