import { withTransaction } from '../../config/db';
import type { AuthUser } from '../../middleware/authenticate';
import { conflict, notFound } from '../../utils/app-error';
import { isForeignKeyViolation, ownerScope } from '../../utils/ownership';
import { buildLayoutGrid } from './layout-grid';
import * as repo from './venues.repository';
import type { CreateVenueInput, LayoutInput, UpdateVenueInput } from './venues.schemas';

async function requireVenue(user: AuthUser, venueId: string): Promise<repo.Venue> {
  const venue = await repo.findVenue(venueId, ownerScope(user));
  if (!venue) throw notFound('Venue');
  return venue;
}

async function requireLayout(user: AuthUser, layoutId: string) {
  const layout = await repo.findLayout(layoutId, ownerScope(user));
  if (!layout) throw notFound('Layout');
  return layout;
}

// ---------- venues ----------

export const listVenues = (user: AuthUser) => repo.listVenues(ownerScope(user));

export const getVenue = (user: AuthUser, venueId: string) => requireVenue(user, venueId);

export async function createVenue(user: AuthUser, input: CreateVenueInput): Promise<repo.Venue> {
  const id = await repo.insertVenue(user.id, input);
  return (await repo.findVenue(id, null))!;
}

export async function updateVenue(
  user: AuthUser,
  venueId: string,
  input: UpdateVenueInput,
): Promise<repo.Venue> {
  const venue = await requireVenue(user, venueId);
  await repo.updateVenue(venueId, { ...venue, ...input });
  return (await repo.findVenue(venueId, null))!;
}

export async function deleteVenue(user: AuthUser, venueId: string): Promise<void> {
  await requireVenue(user, venueId);
  try {
    await repo.deleteVenue(venueId);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw conflict('VENUE_IN_USE', 'This venue has shows and cannot be deleted');
    }
    throw err;
  }
}

// ---------- layouts ----------

export async function listLayouts(user: AuthUser, venueId: string) {
  await requireVenue(user, venueId);
  return repo.listLayouts(venueId);
}

export async function createLayout(
  user: AuthUser,
  venueId: string,
  input: LayoutInput,
): Promise<repo.LayoutDetail> {
  await requireVenue(user, venueId);
  const grid = buildLayoutGrid(input);
  return withTransaction(async (client) => {
    const layoutId = await repo.insertLayout(client, venueId, input.name);
    await repo.replaceLayoutZones(client, layoutId, input.zones, grid);
    return repo.getLayoutDetail(layoutId, client);
  });
}

export async function getLayout(user: AuthUser, layoutId: string): Promise<repo.LayoutDetail> {
  await requireLayout(user, layoutId);
  return repo.getLayoutDetail(layoutId);
}

/** Full replace. Shows already created from this layout keep their own seat snapshot. */
export async function replaceLayout(
  user: AuthUser,
  layoutId: string,
  input: LayoutInput,
): Promise<repo.LayoutDetail> {
  await requireLayout(user, layoutId);
  const grid = buildLayoutGrid(input);
  return withTransaction(async (client) => {
    await repo.renameLayout(client, layoutId, input.name);
    await repo.replaceLayoutZones(client, layoutId, input.zones, grid);
    return repo.getLayoutDetail(layoutId, client);
  });
}

export async function deleteLayout(user: AuthUser, layoutId: string): Promise<void> {
  await requireLayout(user, layoutId);
  try {
    await repo.deleteLayout(layoutId);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw conflict(
        'LAYOUT_IN_USE',
        'Shows were created from this layout, so it cannot be deleted',
      );
    }
    throw err;
  }
}
