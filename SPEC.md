TicketHive — Event Booking Platform (Spec)

Working name; rename freely. Full-stack portfolio project: Angular + Node/Express (TypeScript) + PostgreSQL. Goal: a deployed, recruiter-usable booking platform whose core strength is concurrency-safe booking (no double booking, no overselling).

1. Scope
In scope (v1)
Events and shows (movies, theatre, comedy, concerts, workshops) — category is a browse label only.
Booking happens per zone. Every show has zones; each zone is either:
Standing — capacity + quantity (concert Fan Pit, workshop General).
Seated — seat grid; user picks specific seats (cinema Recliner, stadium East Stand).
A single show may mix standing and seated zones.
Seat/quantity holds (10 min) during checkout, auto-released on expiry.
Mock payment.
Roles: attendee, organizer, admin.
Email + password authentication with JWT access + refresh tokens.
Out of scope (v1) — candidates for v2
Restaurant/table time-slot reservations (stretch; must fit as a new booking strategy without rewriting core).
Real-time seat updates (Socket.io), real payments (Razorpay/Stripe test mode), QR tickets, email notifications, waitlist, Google sign-in, forgot password, AI search.
Bus/travel booking (different domain — not planned).
2. Roles & capabilities
Role	Can do
Attendee	Browse/search events, view shows, hold seats/quantities, check out (mock pay), view & cancel own bookings
Organizer	Everything an attendee can, plus: manage venues & layouts, create events (draft → submit for approval), create shows with per-zone prices, view bookings & sales for own events
Admin	Approve/reject events, manage users (block, change role), manage categories, view platform stats

New registrations are attendee. Admin can promote a user to organizer.

3. Business rules
Max 6 tickets per booking (across all zones of one show).
A hold lasts 10 minutes. Expired holds are treated as available everywhere (lazy expiry), plus a cleanup job.
A user may have one active hold per show; creating a new one releases the old one.
Only published events with scheduled shows in the future are bookable.
Cancellation allowed until 2 hours before show start. Cancelling releases inventory.
Event lifecycle: draft → pending → published | rejected; organizer or admin can set cancelled.
A show's zones/seats are a snapshot of the layout at show creation. Editing a layout later never affects existing shows.
Money is stored as integer paise (₹499 → 49900). Never floats.
All timestamps are TIMESTAMPTZ, stored UTC, displayed in IST on the frontend.
Organizers can only see/modify their own venues, events, shows.
4. Database schema (PostgreSQL)

UUID primary keys (gen_random_uuid()), created_at TIMESTAMPTZ DEFAULT now() on all main tables. Use Postgres enums or CHECK constraints for status fields.

users            id, name, email UNIQUE (lowercased), password_hash,
                 role (attendee|organizer|admin), is_active BOOL, created_at
refresh_tokens   id, user_id → users, token_hash, expires_at, revoked_at, created_at

categories       id, name, slug UNIQUE

venues           id, organizer_id → users, name, address, city, created_at
layouts          id, venue_id → venues, name                      -- "Screen 2", "Main Arena"
layout_zones     id, layout_id → layouts, name, type (standing|seated),
                 capacity INT NULL      -- standing only
                 grid_rows INT NULL, grid_cols INT NULL   -- seated only
                 sort_order INT
layout_seats     id, layout_zone_id → layout_zones, row_label TEXT, seat_number INT,
                 grid_row INT, grid_col INT, kind (seat|aisle|disabled)

events           id, organizer_id → users, category_id → categories, title,
                 slug UNIQUE, description, poster_url, language, duration_min,
                 status (draft|pending|published|rejected|cancelled), rejection_reason, created_at
shows            id, event_id → events, venue_id → venues, layout_id → layouts,
                 starts_at TIMESTAMPTZ, status (scheduled|cancelled|completed), created_at

show_zones       id, show_id → shows, name, type (standing|seated), price_paise INT,
                 capacity INT, sold_count INT DEFAULT 0, held_count INT DEFAULT 0, sort_order,
                 CHECK (sold_count >= 0 AND held_count >= 0 AND sold_count + held_count <= capacity)
show_seats       id, show_id → shows, show_zone_id → show_zones, row_label, seat_number,
                 grid_row, grid_col,
                 status (available|held|booked|blocked), hold_id → holds NULL, held_until TIMESTAMPTZ NULL,
                 UNIQUE (show_id, row_label, seat_number)

holds            id, user_id → users, show_id → shows,
                 status (active|converted|expired|released), expires_at, created_at
hold_items       id, hold_id → holds, show_zone_id → show_zones, show_seat_id → show_seats NULL, quantity INT

bookings         id, booking_ref UNIQUE ("EVT-7K3Q9P"), user_id, show_id,
                 hold_id UNIQUE, idempotency_key UNIQUE,
                 total_paise INT, status (confirmed|cancelled), payment_ref,
                 created_at, cancelled_at
booking_items    id, booking_id → bookings, show_zone_id, show_seat_id NULL,
                 quantity INT, unit_price_paise INT

Indexes: events(status, category_id), events(slug), shows(event_id, starts_at), show_seats(show_id, status), show_seats(hold_id), holds(status, expires_at), bookings(user_id, created_at DESC), refresh_tokens(token_hash).

Show creation copies inventory with INSERT … SELECT from layout_zones → show_zones and layout_seats (kind='seat') → show_seats; seated zone capacity = number of seats.

5. Booking engine (the core)

Implemented as a strategy pattern: BookingStrategy { hold(), confirm(), release() } with StandingZoneStrategy and SeatedZoneStrategy. BookingService orchestrates and owns transactions.

5.1 Create hold — POST /api/holds

Body: { showId, items: [ { zoneId, quantity } | { zoneId, seatIds: [] } ] }

One transaction:

Validate show is bookable; total quantity ≤ 6.
Release this user's existing active hold for the show (if any).
Insert holds row (expires_at = now() + 10 min).
Standing zone:
sql
   UPDATE show_zones SET held_count = held_count + $qty
   WHERE id = $zoneId AND show_id = $showId AND type = 'standing'
     AND sold_count + held_count + $qty <= capacity
   RETURNING id;

0 rows → 409 ZONE_SOLD_OUT. 5. Seated zone (sort seatIds first for consistent lock order → avoids deadlocks):

sql
   UPDATE show_seats
   SET status = 'held', hold_id = $holdId, held_until = $expiresAt
   WHERE id = ANY($seatIds) AND show_id = $showId AND show_zone_id = $zoneId
     AND (status = 'available' OR (status = 'held' AND held_until < now()))
   RETURNING id;

Fewer rows than requested → ROLLBACK → 409 SEATS_UNAVAILABLE with details.seatIds. Also increment show_zones.held_count for seated zones (keeps availability counts uniform). 6. Insert hold_items. COMMIT. Return { holdId, expiresAt, items, totalPaise }.

Note: when a stale held seat is taken over (expired held_until), the previous hold's counts must be corrected — simplest: run releaseExpiredHolds(showId) at step 2 inside the same transaction.

5.2 Confirm booking — POST /api/bookings

Body { holdId, payment: { method: "mock", simulate: "success" | "failure" } }, header Idempotency-Key: <uuid> (required).

If a booking with this idempotency key exists for this user → return it (200).
Transaction: SELECT … FROM holds WHERE id=$1 AND user_id=$2 FOR UPDATE; must be active and expires_at > now() else 409 HOLD_EXPIRED.
Mock payment: failure → 402 PAYMENT_FAILED (hold stays active until expiry so user can retry).
Seats: held → booked (only where hold_id = $holdId). Zones: held_count -= q, sold_count += q.
Insert booking (+ generated booking_ref, payment_ref = "MOCK-…") and booking_items with current unit_price_paise.
Hold → converted. COMMIT. Return booking.
5.3 Release / expiry / cancel
DELETE /api/holds/:id — user releases early (seats → available, held_count -= q, hold → released).
Lazy expiry: availability queries treat status='held' AND held_until < now() as available.
Cleanup job: every 60 s (node-cron / setInterval) marks expired holds expired and returns inventory, in a transaction using FOR UPDATE SKIP LOCKED.
Cancel booking POST /api/bookings/:id/cancel — owner only, ≥ 2 h before show; seats → available, sold_count -= q; status cancelled.
5.4 Required tests
Concurrency: 20 parallel hold requests for the same seat → exactly 1 succeeds.
Concurrency: standing zone capacity 10, 15 parallel requests of qty 1 → exactly 10 succeed, never oversold.
Idempotency: same Idempotency-Key twice → one booking.
Expired hold cannot be confirmed; expired seats become holdable.
Cancellation restores inventory; cancellation inside 2 h is rejected.
6. Authentication
Register POST /api/auth/register {name, email, password} — password min 8 chars; bcrypt (cost 12); role attendee.
Login POST /api/auth/login → body { accessToken, user } + refresh token in cookie.
Access token: JWT (HS256), 15 min, payload { sub: userId, role }.
Refresh token: 48-byte random, 7 days, cookie httpOnly; Secure (prod); SameSite=Lax; Path=/api/auth. Stored as SHA-256 hash.
Refresh POST /api/auth/refresh — validates cookie against DB, rotates (revoke old, issue new), returns new access token. Reuse of a revoked token → revoke all of that user's tokens.
Logout POST /api/auth/logout — revoke + clear cookie.
Me GET /api/auth/me.
Middleware: authenticate (verify JWT), requireRole(...roles). Blocked users (is_active=false) cannot log in or refresh.
Rate limits: login/register 5/min/IP; holds/bookings 20/min/user.
Frontend keeps the access token in memory only (signal); on app start calls /api/auth/refresh to restore the session.
7. API endpoints

All under /api. JSON. Errors: { "error": { "code": "SEATS_UNAVAILABLE", "message": "…", "details": {…} } }. Codes: 400 validation · 401 unauthenticated · 403 forbidden · 404 not found · 409 conflict · 402 payment failed · 429 rate-limited. List endpoints: ?page=1&limit=12 → { data: [...], page, limit, total }.

Auth: POST /auth/register · POST /auth/login · POST /auth/refresh · POST /auth/logout · GET /auth/me

Public

GET /categories
GET /events?q=&category=&city=&from=&to=&page=&limit= — published events with at least one upcoming show; sorted by next show date
GET /events/featured — for home carousel
GET /events/:slug — event + venue + upcoming shows
GET /shows/:id — show + zones (price, type, available = capacity − sold − active held)
GET /shows/:id/seats — seats with effective status (expired holds shown as available; seats held by the requesting user flagged mine: true if authenticated)

Attendee

POST /holds · GET /holds/:id · DELETE /holds/:id
POST /bookings · GET /me/bookings?status=upcoming|past · GET /bookings/:id · POST /bookings/:id/cancel

Organizer (requireRole('organizer','admin'), ownership enforced)

GET/POST /organizer/venues · GET/PATCH/DELETE /organizer/venues/:id
GET/POST /organizer/venues/:id/layouts · GET/PUT/DELETE /organizer/layouts/:id (zones + seat grid in one payload)
GET/POST /organizer/events · GET/PATCH/DELETE /organizer/events/:id (delete only if draft)
POST /organizer/events/:id/submit
GET/POST /organizer/events/:id/shows — create: { venueId, layoutId, startsAt, zonePrices: [{ layoutZoneId, pricePaise }] }
POST /organizer/shows/:id/cancel
GET /organizer/shows/:id/bookings
GET /organizer/dashboard — tickets sold, revenue, upcoming shows, occupancy per show

Admin (requireRole('admin'))

GET /admin/events?status=pending · POST /admin/events/:id/approve · POST /admin/events/:id/reject {reason}
GET /admin/users?q=&role= · PATCH /admin/users/:id {role?, isActive?}
GET/POST/PATCH/DELETE /admin/categories
GET /admin/stats

Swagger UI at /api/docs. Health check GET /api/health (used by frontend wake-up ping).

8. Backend architecture
Node LTS, Express, TypeScript (strict).
pg with raw parameterized SQL (no ORM). Shared withTransaction(fn) helper.
Migrations: node-pg-migrate. Seed script: npm run seed.
Validation: Zod schemas per route (validate middleware).
Security: helmet, cors (allow frontend origin, credentials), express-rate-limit, cookie-parser.
Logging: pino + pino-http.
Errors: AppError(status, code, message, details) + central error handler.
Tests: Jest + Supertest against a separate test database.
server/
├── src/
│   ├── config/          env.ts (Zod-validated env), db.ts (Pool, withTransaction)
│   ├── middleware/      authenticate, requireRole, validate, rateLimit, errorHandler
│   ├── modules/
│   │   ├── auth/        routes, controller, service, repository, schemas
│   │   ├── categories/
│   │   ├── events/
│   │   ├── shows/
│   │   ├── venues/      (venues + layouts)
│   │   ├── holds/
│   │   ├── bookings/
│   │   │   └── strategies/   booking-strategy.ts, standing.strategy.ts, seated.strategy.ts
│   │   ├── organizer/
│   │   └── admin/
│   ├── jobs/            expire-holds.job.ts
│   ├── utils/           app-error.ts, money.ts, slug.ts, booking-ref.ts
│   ├── docs/            openapi
│   ├── app.ts
│   └── server.ts
├── migrations/
├── seeds/
└── tests/
9. Frontend (Angular)

Latest stable Angular: standalone components, Signals, new control flow (@if/@for), lazy-loaded routes, typed reactive forms. UI: Angular Material (dialog, datepicker, stepper, snackbar, menu) + Tailwind CSS (layout, responsive). RxJS for HTTP and debounced search. No NgRx — signal-based service stores.

Layouts
PublicLayout — header (logo, city selector, search, login/profile menu) + footer. Mobile: hamburger, search icon; sticky bottom "total + Proceed" bar on booking pages.
DashboardLayout (organizer, admin) — sidebar + top bar. Mobile: sidebar becomes a drawer.
Routes
Route	Page	Guard
/	Home: featured carousel, category chips, "This weekend", "Upcoming"	—
/events	Browse: filters (category, city, date, price), search, pagination	—
/events/:slug	Event details: poster, info, show date/time picker, zones & prices	—
/book/:showId	Zone picker (standing) and/or seat grid (seated); "Proceed" creates hold	auth
/checkout/:holdId	Summary, countdown, mock pay (success/failure)	auth, unsavedChanges
/bookings/:id	Confirmation / ticket view, cancel	auth
/my-bookings	Upcoming / past tabs	auth
/login, /register	Auth forms + demo login buttons (attendee / organizer / admin)	guest
/organizer/**	Dashboard, venues, layout builder, events, event wizard, show bookings	auth + role
/admin/**	Pending events, users, categories, stats	auth + role
Structure
client/src/app/
├── core/       auth (AuthService, token signal), interceptors (auth+refresh, error, loading),
│               guards (auth, guest, role, unsavedChanges), services (api, server-wake)
├── shared/     components (event-card, seat-grid, zone-picker, countdown-timer, loader,
│               empty-state, page-header), pipes (inr, istDate), models (TS interfaces)
├── layouts/    public-layout, dashboard-layout
└── features/   home, events, booking, account, auth, organizer, admin
Key components
seat-grid — CSS grid; states available / selected / held-by-others / booked / aisle / disabled; color per zone + legend; horizontal scroll on mobile; enforces max 6.
zone-picker — zone cards (price, availability, "Filling fast" < 10%, "Sold out"), quantity stepper.
countdown-timer — hold expiry; at 0 shows "Seats released" and returns to show page.
layout-builder (organizer) — choose rows × cols per seated zone, click cells to toggle aisle/disabled, auto row labels A, B, C…; standing zones just need capacity. Live preview using seat-grid.
event wizard — stepper: details → submit; shows created from event page (venue, layout, date/time, price per zone).
auth interceptor — attaches access token; on 401 calls refresh once (queue concurrent requests), retries, else logs out.
server-wake — pings /api/health at startup; shows "Waking up the server…" banner if slow (Render cold start ~1 min).
error interceptor — maps API error codes to friendly snackbars (e.g. SEATS_UNAVAILABLE → "Someone just booked seats A3, A4 — pick others").

Design: clean, modern, mobile-first; dark text on light, one accent color; event posters prominent; skeleton loaders; empty states.

10. Seed data
Users (password Demo@1234): attendee@demo.com, organizer@demo.com, admin@demo.com (+ 1 extra organizer, a few attendees).
Categories: Movies, Concerts, Comedy, Theatre, Workshops, Sports.
Venues: Cinema (Screen 1: Recliner 2×10, Gold 6×14, Silver 6×14 with aisles), Arena (Fan Pit standing 500, Gold standing 1500, East Stand seated 10×20), Hall (General standing 80).
12–15 published events across categories with shows spread over the next 30 days; a few pending events for the admin demo.
Some seats pre-booked and some bookings for attendee@demo.com so screens aren't empty.
Poster images: royalty-free/placeholder URLs; no real film titles, artist names or logos — invent names.
11. Deployment (free)
Part	Host
Frontend	Vercel (or Netlify)
Backend	Render free web service (sleeps after 15 min idle; ~1 min cold start)
Database	Neon free Postgres (local dev: Postgres already installed)
Vercel rewrite /api/* → Render URL, so the frontend calls same-origin /api and the refresh cookie is first-party (avoids Safari cross-site cookie blocking). Local dev: Angular proxy.conf.json does the same.
Env vars: DATABASE_URL, JWT_ACCESS_SECRET, REFRESH_TOKEN_TTL_DAYS, CORS_ORIGIN, NODE_ENV, PORT.
Neon: use the pooled connection string, ssl: { rejectUnauthorized: true }.
GitHub Actions: lint + test on push.
README: live link, demo credentials, architecture diagram, ER diagram, screenshots, "How double booking is prevented" section, 2-min demo video.
12. Build phases
Foundation — monorepo (server/, client/), TS config, env, DB pool, migrations for all tables, seed script, health endpoint, error handling.
Auth — register/login/refresh/logout/me, middleware, rate limits, tests.
Public catalog — categories, events list/search/filters/pagination, event detail, show + seats endpoints.
Booking engine — holds, confirm (mock pay, idempotency), release, cancel, expiry job, concurrency tests.
Frontend core — Angular setup, Material + Tailwind, layouts, auth pages + interceptor + guards, server-wake.
Frontend attendee flow — home, browse, event detail, zone picker, seat grid, checkout w/ countdown, confirmation, my bookings.
Organizer — venues, layout builder, events, shows, show bookings, dashboard.
Admin — approvals, users, categories, stats.
Polish & deploy — responsive pass, loaders/empty states, Swagger, README, Neon + Render + Vercel, CI.

v2 backlog: Socket.io live seats, Razorpay test mode + webhooks, QR tickets, email confirmations, waitlist, Google sign-in, forgot password, restaurant table reservations (new strategy), AI natural-language search.
