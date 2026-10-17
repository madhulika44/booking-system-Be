CLAUDE.md — TicketHive

Event booking platform. Read SPEC.md before any work — it is the source of truth for scope, schema, business rules and API.

Repos

This project is split into two separate git repos. In SPEC.md, server/ means the backend repo and client/ means the frontend repo — use the repo root directly, do not create a server/ or client/ subfolder.

Backend repo: booking-system-Be (Express API) — runs on http://localhost:4000
Frontend repo: booking-system-Fe (Angular) — runs on http://localhost:4200, proxies /api → http://localhost:4000
Developer OS: Windows, PowerShell. Use cross-platform npm scripts (e.g. cross-env), no bash-only commands.
Stack
Backend — Node LTS, Express, TypeScript (strict), PostgreSQL via pg (raw parameterized SQL, no ORM), node-pg-migrate, Zod, JWT, bcrypt, pino, Jest + Supertest.
Frontend — latest stable Angular (standalone components, Signals, @if/@for control flow, lazy routes, typed reactive forms), Angular Material + Tailwind CSS, RxJS.
Local DB: PostgreSQL on this machine. Production: Neon. Backend on Render, frontend on Vercel.
How to work with me (the developer)
I'm building this to learn and to explain it in interviews, and I'm short on time — move fast.
Give one short plan at the start of a session, then build phases continuously (SPEC §12) unless I say otherwise. Only stop when you need something from me (env values, a decision, a failing step you can't fix).
When env values are needed: create .env.example and .env with placeholder values and clear comments, then ask me to fill in .env.
Create the database tables yourself via migrations, and the database itself if it doesn't exist.
After each phase: a short summary of what was built, how to run/test it, and explain the key logic in simple terms (especially transactions, locking, auth flow). Commit after each phase with a clear message.
Prefer clear, readable code over clever code. Add brief comments only where logic is non-obvious (locking, concurrency, token rotation).
If something in SPEC.md seems wrong or missing, ask me instead of silently changing it.
Non-negotiable rules
All SQL is parameterized ($1, $2). Never string-concatenate user input into SQL.
Every inventory change (holds, bookings, cancellations, expiry) runs inside a transaction via the shared withTransaction helper.
Booking logic follows SPEC §5 exactly: atomic conditional UPDATE for standing zones, seat UPDATE … WHERE status available with sorted seat IDs for seated zones, SELECT … FOR UPDATE on holds when confirming, Idempotency-Key on booking creation.
Money is integer paise end-to-end; format to ₹ only in the UI.
Timestamps are TIMESTAMPTZ; frontend displays IST.
Access token in memory only on the frontend — never localStorage. Refresh token only in an httpOnly cookie, stored hashed in DB.
Validate every request body/query with Zod. Return errors in the shape { error: { code, message, details } }.
Enforce ownership: organizers only touch their own venues/events/shows.
No secrets in code; use .env (commit .env.example only).
Seed data uses invented event/artist/venue names — no real film titles, artists or brand logos.
Conventions
Backend module layout: routes → controller → service → repository. Controllers handle HTTP only; services own business rules and transactions; repositories contain SQL only.
File names kebab-case (booking.service.ts); DB columns snake_case; API JSON camelCase (map in repositories).
Frontend: features lazy-loaded; shared UI in shared/components; state in signal-based services; HTTP via services, never directly in components.
Mobile-first responsive styling with Tailwind; Material for interactive components.
Commands (keep this section updated as scripts are added)
# backend repo
npm run dev          # start API with reload
npm run db:create                 # create tickethive + tickethive_test databases if missing
npm run migrate up                # apply migrations
npm run migrate:test up           # apply migrations to the test database (npm test also does this)
npm run seed                      # load demo data (wipes the dev database first)
npm test                          # run tests (uses TEST_DATABASE_URL)
npm run lint                      # ESLint
npm run typecheck                 # tsc --noEmit
npm run build && npm start        # compile to dist/ and run it

# frontend repo
npm start            # Angular dev server with /api proxy
Definition of done (per phase)
Builds with no TypeScript errors; lint clean.
Tests for the phase pass (booking phase must include the concurrency tests in SPEC §5.4).
Endpoints documented in Swagger.
I can run it locally using the commands above.
