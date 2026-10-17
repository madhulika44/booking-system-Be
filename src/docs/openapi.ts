/**
 * Hand-written OpenAPI 3 document served at /api/docs.
 * Kept as plain data so it is easy to read next to the routes.
 */

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'TicketHive API',
    version: '1.0.0',
    description:
      'Event booking platform API. Money is integer paise; timestamps are ISO-8601 UTC. ' +
      'Authenticate with "Authorize" using the accessToken from /auth/login.',
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
    },
  },
  tags: [{ name: 'System' }],
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
  } as Record<string, unknown>,
};

export { errorResponse };
