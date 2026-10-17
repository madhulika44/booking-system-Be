import { withTransaction } from '../config/db';
import { logger } from '../config/logger';
import { releaseExpiredHolds } from '../modules/bookings/booking.service';

const INTERVAL_MS = 60_000;
const BATCH_SIZE = 500;

/**
 * Cleanup job (SPEC §5.3). Reads already treat lapsed holds as available (lazy expiry);
 * this job makes it permanent: hold → expired, seats → available, counters returned.
 * Locks use FOR UPDATE SKIP LOCKED so it never waits on a checkout in progress.
 */
export async function runExpireHolds(): Promise<number> {
  let total = 0;
  // drain in batches so one run can't hold a huge transaction open
  for (;;) {
    const expired = await withTransaction((client) =>
      releaseExpiredHolds(client, { limit: BATCH_SIZE }),
    );
    total += expired;
    if (expired < BATCH_SIZE) return total;
  }
}

export function startExpireHoldsJob(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // previous run still going
    running = true;
    runExpireHolds()
      .then((count) => {
        if (count) logger.info({ count }, 'Expired holds released');
      })
      .catch((err: unknown) => logger.error({ err }, 'Expire-holds job failed'))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
