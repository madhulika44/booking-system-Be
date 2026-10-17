import {
  errorResponse,
  jsonBody,
  ok,
  paginationParams,
  queryParam,
  secured,
  uuidParam,
} from './common';

const tags = ['Organizer'];
const base = { tags, security: secured };
const authErrors = {
  401: errorResponse('UNAUTHENTICATED'),
  403: errorResponse('FORBIDDEN (not organizer/admin)'),
};
const notFound = { 404: errorResponse('NOT_FOUND (or owned by another organizer)') };

const venue = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    organizerId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    address: { type: 'string' },
    city: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    layoutCount: { type: 'integer' },
  },
};

const venueBody = {
  name: { type: 'string', example: 'Horizon Arena' },
  address: { type: 'string', example: 'Bandra Reclamation' },
  city: { type: 'string', example: 'Mumbai' },
};

const layoutBody = jsonBody(
  {
    name: { type: 'string', example: 'Main Arena' },
    zones: {
      type: 'array',
      description:
        'Standing: { name, type: "standing", capacity }. Seated: { name, type: "seated", rows, cols, cells? } where cells lists only aisle/disabled positions. Row letters continue across seated zones (A, B, … then AA).',
      items: { type: 'object' },
      example: [
        { name: 'Fan Pit', type: 'standing', capacity: 500 },
        {
          name: 'East Stand',
          type: 'seated',
          rows: 3,
          cols: 6,
          cells: [
            { row: 1, col: 4, kind: 'aisle' },
            { row: 2, col: 4, kind: 'aisle' },
            { row: 3, col: 4, kind: 'aisle' },
            { row: 3, col: 6, kind: 'disabled' },
          ],
        },
      ],
    },
  },
  ['name', 'zones'],
);

const layoutDetail = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    venueId: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    zones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['standing', 'seated'] },
          sortOrder: { type: 'integer' },
          capacity: { type: 'integer', description: 'Seated: number of sellable seats' },
          rows: { type: 'integer', nullable: true },
          cols: { type: 'integer', nullable: true },
          cells: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rowLabel: { type: 'string' },
                seatNumber: { type: 'integer', description: '0 for aisles' },
                gridRow: { type: 'integer' },
                gridCol: { type: 'integer' },
                kind: { type: 'string', enum: ['seat', 'aisle', 'disabled'] },
              },
            },
          },
        },
      },
    },
  },
};

const managedEvent = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    posterUrl: { type: 'string', nullable: true },
    language: { type: 'string', nullable: true },
    durationMin: { type: 'integer', nullable: true },
    status: { type: 'string', enum: ['draft', 'pending', 'published', 'rejected', 'cancelled'] },
    rejectionReason: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    category: { type: 'object' },
    organizer: { type: 'object' },
    showCount: { type: 'integer' },
    nextShowAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const managedShow = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    eventId: { type: 'string' },
    startsAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['scheduled', 'cancelled', 'completed'] },
    venue: { type: 'object' },
    layout: { type: 'object' },
    zones: { type: 'array', items: { type: 'object' } },
    capacity: { type: 'integer' },
    ticketsSold: { type: 'integer' },
    revenuePaise: { type: 'integer' },
  },
};

const eventBody = {
  title: { type: 'string', example: 'Midnight Raga Live' },
  categoryId: { type: 'string', format: 'uuid' },
  description: { type: 'string' },
  posterUrl: { type: 'string', nullable: true },
  language: { type: 'string', nullable: true },
  durationMin: { type: 'integer', nullable: true },
};

export const organizerPaths = {
  '/organizer/venues': {
    get: {
      ...base,
      summary: 'Your venues',
      responses: {
        200: ok('Venues', {
          type: 'object',
          properties: { data: { type: 'array', items: venue } },
        }),
        ...authErrors,
      },
    },
    post: {
      ...base,
      summary: 'Create a venue',
      requestBody: jsonBody(venueBody, ['name', 'address', 'city']),
      responses: { 201: ok('Venue', venue), 400: errorResponse('VALIDATION_ERROR'), ...authErrors },
    },
  },
  '/organizer/venues/{id}': {
    get: {
      ...base,
      summary: 'One venue',
      parameters: [uuidParam('id')],
      responses: { 200: ok('Venue', venue), ...notFound },
    },
    patch: {
      ...base,
      summary: 'Update a venue',
      parameters: [uuidParam('id')],
      requestBody: jsonBody(venueBody),
      responses: { 200: ok('Venue', venue), ...notFound },
    },
    delete: {
      ...base,
      summary: 'Delete a venue (only if no shows use it)',
      parameters: [uuidParam('id')],
      responses: { 204: ok('Deleted'), 409: errorResponse('VENUE_IN_USE'), ...notFound },
    },
  },
  '/organizer/venues/{id}/layouts': {
    get: {
      ...base,
      summary: 'Layouts of a venue (zone summary)',
      parameters: [uuidParam('id')],
      responses: { 200: ok('Layouts'), ...notFound },
    },
    post: {
      ...base,
      summary: 'Create a layout: zones + seat grid in one payload',
      parameters: [uuidParam('id')],
      requestBody: layoutBody,
      responses: {
        201: ok('Layout', layoutDetail),
        400: errorResponse('VALIDATION_ERROR'),
        ...notFound,
      },
    },
  },
  '/organizer/layouts/{id}': {
    get: {
      ...base,
      summary: 'Layout with full cell grid',
      parameters: [uuidParam('id')],
      responses: { 200: ok('Layout', layoutDetail), ...notFound },
    },
    put: {
      ...base,
      summary: 'Replace a layout (existing shows keep their own snapshot)',
      parameters: [uuidParam('id')],
      requestBody: layoutBody,
      responses: { 200: ok('Layout', layoutDetail), ...notFound },
    },
    delete: {
      ...base,
      summary: 'Delete a layout (only if no shows use it)',
      parameters: [uuidParam('id')],
      responses: { 204: ok('Deleted'), 409: errorResponse('LAYOUT_IN_USE'), ...notFound },
    },
  },
  '/organizer/events': {
    get: {
      ...base,
      summary: 'Your events',
      parameters: [
        queryParam('status', {
          type: 'string',
          enum: ['draft', 'pending', 'published', 'rejected', 'cancelled'],
        }),
        queryParam('q', { type: 'string' }, 'Search in title'),
        ...paginationParams,
      ],
      responses: { 200: ok('Paginated events'), ...authErrors },
    },
    post: {
      ...base,
      summary: 'Create a draft event',
      requestBody: jsonBody(eventBody, ['title', 'categoryId']),
      responses: {
        201: ok('Event (with shows: [])', managedEvent),
        400: errorResponse('VALIDATION_ERROR | INVALID_CATEGORY'),
      },
    },
  },
  '/organizer/events/{id}': {
    get: {
      ...base,
      summary: 'Event with all its shows',
      parameters: [uuidParam('id')],
      responses: { 200: ok('Event + shows', managedEvent), ...notFound },
    },
    patch: {
      ...base,
      summary:
        'Edit a draft/rejected event, or send { "status": "cancelled" } alone to cancel it (and its scheduled shows)',
      parameters: [uuidParam('id')],
      requestBody: jsonBody({ ...eventBody, status: { type: 'string', enum: ['cancelled'] } }),
      responses: {
        200: ok('Event + shows', managedEvent),
        409: errorResponse('EVENT_NOT_EDITABLE | EVENT_ALREADY_CANCELLED'),
        ...notFound,
      },
    },
    delete: {
      ...base,
      summary: 'Delete a draft event',
      parameters: [uuidParam('id')],
      responses: { 204: ok('Deleted'), 409: errorResponse('EVENT_NOT_DRAFT'), ...notFound },
    },
  },
  '/organizer/events/{id}/submit': {
    post: {
      ...base,
      summary: 'Submit a draft/rejected event for admin approval (→ pending)',
      parameters: [uuidParam('id')],
      responses: {
        200: ok('Event', managedEvent),
        409: errorResponse('EVENT_NOT_SUBMITTABLE'),
        ...notFound,
      },
    },
  },
  '/organizer/events/{id}/shows': {
    get: {
      ...base,
      summary: 'Shows of an event with sales per zone',
      parameters: [uuidParam('id')],
      responses: {
        200: ok('Shows', {
          type: 'object',
          properties: { data: { type: 'array', items: managedShow } },
        }),
        ...notFound,
      },
    },
    post: {
      ...base,
      summary: 'Create a show; zones/seats are snapshotted from the layout',
      parameters: [uuidParam('id')],
      requestBody: jsonBody(
        {
          venueId: { type: 'string', format: 'uuid' },
          layoutId: { type: 'string', format: 'uuid' },
          startsAt: { type: 'string', format: 'date-time', example: '2026-11-20T14:00:00Z' },
          zonePrices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                layoutZoneId: { type: 'string' },
                pricePaise: { type: 'integer', example: 49900 },
              },
            },
          },
        },
        ['venueId', 'layoutId', 'startsAt', 'zonePrices'],
      ),
      responses: {
        201: ok('Show', managedShow),
        400: errorResponse('ZONE_PRICES_MISMATCH | SHOW_IN_PAST | LAYOUT_VENUE_MISMATCH'),
        409: errorResponse('EVENT_CANCELLED'),
        ...notFound,
      },
    },
  },
  '/organizer/shows/{id}/cancel': {
    post: {
      ...base,
      summary: 'Cancel a show: its bookings are cancelled and holds released',
      parameters: [uuidParam('id')],
      responses: {
        200: ok('Result', {
          type: 'object',
          properties: {
            show: managedShow,
            cancelledBookings: { type: 'integer' },
            releasedHolds: { type: 'integer' },
          },
        }),
        409: errorResponse('SHOW_NOT_SCHEDULED'),
        ...notFound,
      },
    },
  },
  '/organizer/shows/{id}/bookings': {
    get: {
      ...base,
      summary: 'Bookings of a show (with buyer name/email)',
      parameters: [uuidParam('id'), ...paginationParams],
      responses: { 200: ok('{ show, data, page, limit, total }'), ...notFound },
    },
  },
  '/organizer/dashboard': {
    get: {
      ...base,
      summary: 'Tickets sold, revenue, upcoming shows, occupancy per show',
      responses: {
        200: ok('Dashboard', {
          type: 'object',
          properties: {
            ticketsSold: { type: 'integer' },
            revenuePaise: { type: 'integer' },
            confirmedBookings: { type: 'integer' },
            upcomingShowCount: { type: 'integer' },
            eventsByStatus: { type: 'object' },
            upcomingShows: { type: 'array', items: { type: 'object' } },
          },
        }),
        ...authErrors,
      },
    },
  },
};
