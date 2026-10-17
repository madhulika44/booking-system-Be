import { errorResponse, ok, paginationParams, queryParam, uuidParam } from './common';

const eventCard = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    slug: { type: 'string' },
    posterUrl: { type: 'string', nullable: true },
    language: { type: 'string', nullable: true },
    durationMin: { type: 'integer', nullable: true },
    category: {
      type: 'object',
      properties: { name: { type: 'string' }, slug: { type: 'string' } },
    },
    nextShowAt: { type: 'string', format: 'date-time' },
    minPricePaise: { type: 'integer', nullable: true, example: 22000 },
    cities: { type: 'array', items: { type: 'string' } },
  },
};

const venue = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    address: { type: 'string' },
    city: { type: 'string' },
  },
};

const zone = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Fan Pit' },
    type: { type: 'string', enum: ['standing', 'seated'] },
    pricePaise: { type: 'integer', example: 450000 },
    capacity: { type: 'integer' },
    available: { type: 'integer', description: 'capacity − sold − active holds' },
    sortOrder: { type: 'integer' },
  },
};

export const catalogPaths = {
  '/categories': {
    get: {
      tags: ['Catalog'],
      summary: 'All categories',
      responses: {
        200: ok('Categories', { type: 'object', properties: { data: { type: 'array' } } }),
      },
    },
  },
  '/events': {
    get: {
      tags: ['Catalog'],
      summary: 'Published events with at least one upcoming show, sorted by next show date',
      parameters: [
        queryParam('q', { type: 'string' }, 'Search in title and description'),
        queryParam('category', { type: 'string' }, 'Category slug, e.g. movies'),
        queryParam('city', { type: 'string' }, 'Venue city (case-insensitive)'),
        queryParam('from', { type: 'string', format: 'date-time' }, 'Show starts at/after'),
        queryParam('to', { type: 'string', format: 'date-time' }, 'Show starts at/before'),
        ...paginationParams,
      ],
      responses: {
        200: ok('Paginated events', {
          type: 'object',
          properties: {
            data: { type: 'array', items: eventCard },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
          },
        }),
        400: errorResponse('VALIDATION_ERROR'),
      },
    },
  },
  '/events/featured': {
    get: {
      tags: ['Catalog'],
      summary: 'Home carousel: best-selling upcoming events',
      responses: {
        200: ok('Featured events', {
          type: 'object',
          properties: { data: { type: 'array', items: eventCard } },
        }),
      },
    },
  },
  '/events/{slug}': {
    get: {
      tags: ['Catalog'],
      summary: 'Event details with venues and upcoming shows',
      parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: ok('Event'), 404: errorResponse('NOT_FOUND') },
    },
  },
  '/shows/{id}': {
    get: {
      tags: ['Catalog'],
      summary: 'Show with event, venue and zones (price, type, live availability)',
      parameters: [uuidParam('id')],
      responses: {
        200: ok('Show', {
          type: 'object',
          properties: {
            id: { type: 'string' },
            startsAt: { type: 'string', format: 'date-time' },
            status: { type: 'string' },
            bookable: { type: 'boolean' },
            event: { type: 'object' },
            venue,
            zones: { type: 'array', items: zone },
          },
        }),
        404: errorResponse('NOT_FOUND'),
      },
    },
  },
  '/shows/{id}/seats': {
    get: {
      tags: ['Catalog'],
      summary: 'Seat map per seated zone (expired holds shown as available)',
      description: 'Send a bearer token (optional) to get mine: true on seats you currently hold.',
      parameters: [uuidParam('id')],
      security: [{}, { bearerAuth: [] }],
      responses: {
        200: ok('Seat map', {
          type: 'object',
          properties: {
            showId: { type: 'string' },
            zones: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  pricePaise: { type: 'integer' },
                  rows: { type: 'integer' },
                  cols: { type: 'integer' },
                  seats: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        rowLabel: { type: 'string', example: 'A' },
                        seatNumber: { type: 'integer' },
                        gridRow: { type: 'integer' },
                        gridCol: { type: 'integer' },
                        status: {
                          type: 'string',
                          enum: ['available', 'held', 'booked', 'blocked'],
                        },
                        mine: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        404: errorResponse('NOT_FOUND'),
      },
    },
  },
};
