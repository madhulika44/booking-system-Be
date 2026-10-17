import { notFound } from '../../utils/app-error';
import * as repo from './shows.repository';

async function requirePublicShow(showId: string): Promise<repo.ShowSummary> {
  const show = await repo.findPublicShow(showId);
  if (!show) throw notFound('Show');
  return show;
}

export async function getShow(showId: string) {
  const show = await requirePublicShow(showId);
  const zones = await repo.listZonesWithAvailability(showId);
  return { ...show, zones };
}

export async function getSeatMap(showId: string, userId: string | null) {
  await requirePublicShow(showId);
  return { showId, zones: await repo.listSeatMap(showId, userId) };
}
