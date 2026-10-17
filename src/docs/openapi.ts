/**
 * Hand-written OpenAPI 3 document served at /api/docs.
 * Each area's paths live in its own file under docs/ and are merged here.
 */
import { authPaths } from './auth.paths';
import { bookingPaths } from './booking.paths';
import { adminPaths } from './admin.paths';
import { catalogPaths } from './catalog.paths';
import { organizerPaths } from './organizer.paths';
import { errorResponse } from './common';

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'TicketHive API',
    version: '1.0.0',
    description:
      'Event booking platform API. Money is integer paise; timestamps are ISO-8601 UTC. ' +
      'Click "Authorize" and paste the accessToken from /auth/login.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'SEATS_UNAVAILABLE' },
              message: { type: 'string' },
              details: { type: 'object' },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['attendee', 'organizer', 'admin'] },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  tags: [
    { name: 'System' },
    { name: 'Auth' },
    { name: 'Catalog' },
    { name: 'Booking' },
    { name: 'Organizer' },
    { name: 'Admin' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check (used by the frontend wake-up ping)',
        responses: {
          200: { description: 'API and database are up' },
          503: errorResponse('Database is unreachable'),
        },
      },
    },
    ...authPaths,
    ...catalogPaths,
    ...bookingPaths,
    ...organizerPaths,
    ...adminPaths,
  },
};
