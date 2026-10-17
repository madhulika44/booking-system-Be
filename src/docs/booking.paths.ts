import {
  errorResponse,
  jsonBody,
  ok,
  paginationParams,
  queryParam,
  secured,
  uuidParam,
} from './common';

const holdView = {
  type: 'object',
  properties: {
    holdId: { type: 'string', format: 'uuid' },
    showId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['active', 'converted', 'expired', 'released'] },
    expiresAt: { type: 'string', format: 'date-time' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          zoneId: { type: 'string' },
          zoneName: { type: 'string' },
          zoneType: { type: 'string', enum: ['standing', 'seated'] },
          unitPricePaise: { type: 'integer' },
          quantity: { type: 'integer' },
          seats: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    totalQuantity: { type: 'integer' },
    totalPaise: { type: 'integer' },
  },
};

const bookingView = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    bookingRef: { type: 'string', example: 'EVT-7K3Q9P' },
    status: { type: 'string', enum: ['confirmed', 'cancelled'] },
    totalPaise: { type: 'integer' },
    paymentRef: { type: 'string', example: 'MOCK-4F8K2Q9XTA' },
    createdAt: { type: 'string', format: 'date-time' },
    cancelledAt: { type: 'string', format: 'date-time', nullable: true },
    canCancel: { type: 'boolean' },
    show: { type: 'object' },
    items: { type: 'array', items: { type: 'object' } },
  },
};

export const bookingPaths = {
  '/holds': {
    post: {
      tags: ['Booking'],
      summary: 'Hold tickets for 10 minutes (max 6 per show; replaces your previous hold)',
      security: secured,
      requestBody: jsonBody(
        {
          showId: { type: 'string', format: 'uuid' },
          items: {
            type: 'array',
            description: 'Standing: { zoneId, quantity }. Seated: { zoneId, seatIds }.',
            items: {
              oneOf: [
                {
                  type: 'object',
                  properties: { zoneId: { type: 'string' }, quantity: { type: 'integer' } },
                },
                {
                  type: 'object',
                  properties: {
                    zoneId: { type: 'string' },
                    seatIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              ],
            },
          },
        },
        ['showId', 'items'],
      ),
      responses: {
        201: ok('Hold created', holdView),
        400: errorResponse(
          'VALIDATION_ERROR | MAX_TICKETS_EXCEEDED | INVALID_ZONE | ZONE_TYPE_MISMATCH',
        ),
        401: errorResponse('UNAUTHENTICATED'),
        404: errorResponse('Show NOT_FOUND'),
        409: errorResponse(
          'ZONE_SOLD_OUT | SEATS_UNAVAILABLE (details.seatIds) | SHOW_NOT_BOOKABLE',
        ),
        429: errorResponse('RATE_LIMITED (20/min per user)'),
      },
    },
  },
  '/holds/{id}': {
    get: {
      tags: ['Booking'],
      summary: 'Your hold (for the checkout page)',
      security: secured,
      parameters: [uuidParam('id')],
      responses: { 200: ok('Hold', holdView), 404: errorResponse('NOT_FOUND') },
    },
    delete: {
      tags: ['Booking'],
      summary: 'Release your hold early',
      security: secured,
      parameters: [uuidParam('id')],
      responses: {
        204: ok('Released'),
        404: errorResponse('NOT_FOUND'),
        409: errorResponse('HOLD_NOT_ACTIVE'),
      },
    },
  },
  '/bookings': {
    post: {
      tags: ['Booking'],
      summary: 'Confirm a hold with mock payment',
      description:
        'Requires an Idempotency-Key header (UUID). Repeating the request with the same key returns the original booking (200) instead of creating a second one.',
      security: secured,
      parameters: [
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: jsonBody(
        {
          holdId: { type: 'string', format: 'uuid' },
          payment: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: ['mock'] },
              simulate: { type: 'string', enum: ['success', 'failure'] },
            },
          },
        },
        ['holdId', 'payment'],
      ),
      responses: {
        201: ok('Booking created', bookingView),
        200: ok('Existing booking for this Idempotency-Key', bookingView),
        400: errorResponse('VALIDATION_ERROR | IDEMPOTENCY_KEY_REQUIRED'),
        402: errorResponse('PAYMENT_FAILED (hold stays active)'),
        404: errorResponse('Hold NOT_FOUND'),
        409: errorResponse('HOLD_EXPIRED | HOLD_ALREADY_CONVERTED | IDEMPOTENCY_KEY_REUSED'),
      },
    },
  },
  '/bookings/{id}': {
    get: {
      tags: ['Booking'],
      summary: 'One of your bookings',
      security: secured,
      parameters: [uuidParam('id')],
      responses: { 200: ok('Booking', bookingView), 404: errorResponse('NOT_FOUND') },
    },
  },
  '/bookings/{id}/cancel': {
    post: {
      tags: ['Booking'],
      summary: 'Cancel your booking (until 2 hours before the show)',
      security: secured,
      parameters: [uuidParam('id')],
      responses: {
        200: ok('Cancelled booking', bookingView),
        404: errorResponse('NOT_FOUND'),
        409: errorResponse('CANCELLATION_WINDOW_CLOSED | BOOKING_ALREADY_CANCELLED'),
      },
    },
  },
  '/me/bookings': {
    get: {
      tags: ['Booking'],
      summary: 'Your bookings',
      security: secured,
      parameters: [
        queryParam('status', { type: 'string', enum: ['upcoming', 'past'] }),
        ...paginationParams,
      ],
      responses: { 200: ok('Paginated bookings') },
    },
  },
};
