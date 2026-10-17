import {
  errorResponse,
  jsonBody,
  ok,
  paginationParams,
  queryParam,
  secured,
  uuidParam,
} from './common';

const base = { tags: ['Admin'], security: secured };
const authErrors = {
  401: errorResponse('UNAUTHENTICATED'),
  403: errorResponse('FORBIDDEN (not admin)'),
};

const adminUser = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string', enum: ['attendee', 'organizer', 'admin'] },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    bookingCount: { type: 'integer' },
  },
};

const category = {
  type: 'object',
  properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' } },
};

export const adminPaths = {
  '/admin/events': {
    get: {
      ...base,
      summary: 'All events (e.g. ?status=pending for the approval queue)',
      parameters: [
        queryParam('status', {
          type: 'string',
          enum: ['draft', 'pending', 'published', 'rejected', 'cancelled'],
        }),
        queryParam('q', { type: 'string' }, 'Search in title'),
        ...paginationParams,
      ],
      responses: { 200: ok('Paginated events (same shape as organizer events)'), ...authErrors },
    },
  },
  '/admin/events/{id}/approve': {
    post: {
      ...base,
      summary: 'pending → published',
      parameters: [uuidParam('id')],
      responses: {
        200: ok('Event'),
        404: errorResponse('NOT_FOUND'),
        409: errorResponse('EVENT_NOT_PENDING'),
      },
    },
  },
  '/admin/events/{id}/reject': {
    post: {
      ...base,
      summary: 'pending → rejected with a reason the organizer sees',
      parameters: [uuidParam('id')],
      requestBody: jsonBody({ reason: { type: 'string', example: 'Poster is missing' } }, [
        'reason',
      ]),
      responses: {
        200: ok('Event'),
        404: errorResponse('NOT_FOUND'),
        409: errorResponse('EVENT_NOT_PENDING'),
      },
    },
  },
  '/admin/users': {
    get: {
      ...base,
      summary: 'Users',
      parameters: [
        queryParam('q', { type: 'string' }, 'Search name or email'),
        queryParam('role', { type: 'string', enum: ['attendee', 'organizer', 'admin'] }),
        ...paginationParams,
      ],
      responses: {
        200: ok('Paginated users', {
          type: 'object',
          properties: { data: { type: 'array', items: adminUser } },
        }),
        ...authErrors,
      },
    },
  },
  '/admin/users/{id}': {
    patch: {
      ...base,
      summary: 'Change role and/or block (isActive=false revokes their refresh tokens)',
      parameters: [uuidParam('id')],
      requestBody: jsonBody({
        role: { type: 'string', enum: ['attendee', 'organizer', 'admin'] },
        isActive: { type: 'boolean' },
      }),
      responses: {
        200: ok('User', adminUser),
        404: errorResponse('NOT_FOUND'),
        409: errorResponse('CANNOT_MODIFY_SELF'),
      },
    },
  },
  '/admin/categories': {
    get: { ...base, summary: 'Categories with event counts', responses: { 200: ok('Categories') } },
    post: {
      ...base,
      summary: 'Create a category (slug derived from name if omitted)',
      requestBody: jsonBody({ name: { type: 'string' }, slug: { type: 'string' } }, ['name']),
      responses: { 201: ok('Category', category), 409: errorResponse('CATEGORY_EXISTS') },
    },
  },
  '/admin/categories/{id}': {
    patch: {
      ...base,
      summary: 'Rename a category',
      parameters: [uuidParam('id')],
      requestBody: jsonBody({ name: { type: 'string' }, slug: { type: 'string' } }),
      responses: {
        200: ok('Category', category),
        404: errorResponse('NOT_FOUND'),
        409: errorResponse('CATEGORY_EXISTS'),
      },
    },
    delete: {
      ...base,
      summary: 'Delete an unused category',
      parameters: [uuidParam('id')],
      responses: {
        204: ok('Deleted'),
        404: errorResponse('NOT_FOUND'),
        409: errorResponse('CATEGORY_IN_USE'),
      },
    },
  },
  '/admin/stats': {
    get: {
      ...base,
      summary: 'Platform stats',
      responses: {
        200: ok('Stats', {
          type: 'object',
          properties: {
            users: { type: 'object' },
            events: { type: 'object' },
            shows: { type: 'object' },
            bookings: { type: 'object' },
            ticketsSold: { type: 'integer' },
            revenuePaise: { type: 'integer' },
          },
        }),
        ...authErrors,
      },
    },
  },
};
