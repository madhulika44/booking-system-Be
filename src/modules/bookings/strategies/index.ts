import type { BookingStrategy, ZoneType } from './booking-strategy';
import { seatedZoneStrategy } from './seated.strategy';
import { standingZoneStrategy } from './standing.strategy';

const strategies: Record<ZoneType, BookingStrategy> = {
  standing: standingZoneStrategy,
  seated: seatedZoneStrategy,
};

export const strategyFor = (type: ZoneType): BookingStrategy => strategies[type];
