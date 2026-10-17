-- Up Migration

-- ---------- Auth ----------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'attendee' CHECK (role IN ('attendee', 'organizer', 'admin')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_token_hash_idx ON refresh_tokens (token_hash);

-- ---------- Catalog ----------
CREATE TABLE categories (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE venues (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  address      TEXT NOT NULL,
  city         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE layouts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE layout_zones (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layout_id  UUID NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('standing', 'seated')),
  capacity   INT CHECK (capacity > 0),
  grid_rows  INT CHECK (grid_rows > 0),
  grid_cols  INT CHECK (grid_cols > 0),
  sort_order INT NOT NULL DEFAULT 0,
  -- standing zones need a capacity; seated zones need a grid
  CHECK (
    (type = 'standing' AND capacity IS NOT NULL)
    OR (type = 'seated' AND grid_rows IS NOT NULL AND grid_cols IS NOT NULL)
  )
);

CREATE TABLE layout_seats (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layout_zone_id UUID NOT NULL REFERENCES layout_zones(id) ON DELETE CASCADE,
  row_label      TEXT NOT NULL,
  seat_number    INT NOT NULL,
  grid_row       INT NOT NULL,
  grid_col       INT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'seat' CHECK (kind IN ('seat', 'aisle', 'disabled'))
);

CREATE TABLE events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id     UUID NOT NULL REFERENCES users(id),
  category_id      UUID NOT NULL REFERENCES categories(id),
  title            TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE, -- the UNIQUE constraint is the events(slug) index
  description      TEXT NOT NULL DEFAULT '',
  poster_url       TEXT,
  language         TEXT,
  duration_min     INT CHECK (duration_min > 0),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'pending', 'published', 'rejected', 'cancelled')),
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_status_category_idx ON events (status, category_id);

CREATE TABLE shows (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  venue_id   UUID NOT NULL REFERENCES venues(id),
  layout_id  UUID NOT NULL REFERENCES layouts(id),
  starts_at  TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shows_event_starts_idx ON shows (event_id, starts_at);

-- ---------- Inventory (snapshot per show) ----------
CREATE TABLE show_zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id     UUID NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('standing', 'seated')),
  price_paise INT NOT NULL CHECK (price_paise >= 0),
  capacity    INT NOT NULL CHECK (capacity >= 0),
  sold_count  INT NOT NULL DEFAULT 0,
  held_count  INT NOT NULL DEFAULT 0,
  sort_order  INT NOT NULL DEFAULT 0,
  -- last line of defence against overselling, even if app logic has a bug
  CONSTRAINT show_zones_inventory_check
    CHECK (sold_count >= 0 AND held_count >= 0 AND sold_count + held_count <= capacity)
);

CREATE TABLE holds (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  show_id    UUID NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'expired', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX holds_status_expires_idx ON holds (status, expires_at);
-- Enforces "one active hold per user per show" even if the same user fires two requests at once.
CREATE UNIQUE INDEX holds_one_active_per_user_show_idx ON holds (user_id, show_id) WHERE status = 'active';

CREATE TABLE show_seats (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id      UUID NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  show_zone_id UUID NOT NULL REFERENCES show_zones(id) ON DELETE CASCADE,
  row_label    TEXT NOT NULL,
  seat_number  INT NOT NULL,
  grid_row     INT NOT NULL,
  grid_col     INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'booked', 'blocked')),
  hold_id      UUID REFERENCES holds(id) ON DELETE SET NULL,
  held_until   TIMESTAMPTZ,
  UNIQUE (show_id, row_label, seat_number)
);
CREATE INDEX show_seats_show_status_idx ON show_seats (show_id, status);
CREATE INDEX show_seats_hold_idx ON show_seats (hold_id);

CREATE TABLE hold_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id      UUID NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
  show_zone_id UUID NOT NULL REFERENCES show_zones(id),
  show_seat_id UUID REFERENCES show_seats(id),
  quantity     INT NOT NULL CHECK (quantity > 0)
);
CREATE INDEX hold_items_hold_idx ON hold_items (hold_id);

-- ---------- Bookings ----------
CREATE TABLE bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref     TEXT NOT NULL UNIQUE,
  user_id         UUID NOT NULL REFERENCES users(id),
  show_id         UUID NOT NULL REFERENCES shows(id),
  hold_id         UUID UNIQUE REFERENCES holds(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  total_paise     INT NOT NULL CHECK (total_paise >= 0),
  status          TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  payment_ref     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at    TIMESTAMPTZ
);
CREATE INDEX bookings_user_created_idx ON bookings (user_id, created_at DESC);

CREATE TABLE booking_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  show_zone_id     UUID NOT NULL REFERENCES show_zones(id),
  show_seat_id     UUID REFERENCES show_seats(id),
  quantity         INT NOT NULL CHECK (quantity > 0),
  unit_price_paise INT NOT NULL CHECK (unit_price_paise >= 0)
);
CREATE INDEX booking_items_booking_idx ON booking_items (booking_id);

-- Down Migration

DROP TABLE IF EXISTS booking_items;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS hold_items;
DROP TABLE IF EXISTS show_seats;
DROP TABLE IF EXISTS holds;
DROP TABLE IF EXISTS show_zones;
DROP TABLE IF EXISTS shows;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS layout_seats;
DROP TABLE IF EXISTS layout_zones;
DROP TABLE IF EXISTS layouts;
DROP TABLE IF EXISTS venues;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;
