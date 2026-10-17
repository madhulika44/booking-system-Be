import { errorResponse, jsonBody, ok, secured } from './common';

const authResult = ok('Access token + user. Refresh token is set as an httpOnly cookie.', {
  type: 'object',
  properties: {
    accessToken: { type: 'string' },
    user: { $ref: '#/components/schemas/User' },
  },
});

export const authPaths = {
  '/auth/register': {
    post: {
      tags: ['Auth'],
      summary: 'Create an attendee account (5/min per IP)',
      requestBody: jsonBody(
        {
          name: { type: 'string', example: 'Asha' },
          email: { type: 'string', example: 'asha@example.com' },
          password: { type: 'string', minLength: 8, example: 'Secret@123' },
        },
        ['name', 'email', 'password'],
      ),
      responses: {
        201: authResult,
        400: errorResponse('Validation error'),
        409: errorResponse('EMAIL_TAKEN'),
        429: errorResponse('RATE_LIMITED'),
      },
    },
  },
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Log in (5/min per IP)',
      requestBody: jsonBody(
        {
          email: { type: 'string', example: 'attendee@demo.com' },
          password: { type: 'string', example: 'Demo@1234' },
        },
        ['email', 'password'],
      ),
      responses: {
        200: authResult,
        401: errorResponse('INVALID_CREDENTIALS'),
        403: errorResponse('ACCOUNT_BLOCKED'),
        429: errorResponse('RATE_LIMITED'),
      },
    },
  },
  '/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Rotate the refresh cookie and get a new access token',
      description:
        'Reads the refresh_token cookie. Each refresh token works once; reusing a revoked token revokes all of the user’s sessions.',
      responses: {
        200: authResult,
        401: errorResponse('INVALID_REFRESH_TOKEN | REFRESH_TOKEN_REUSED'),
        403: errorResponse('ACCOUNT_BLOCKED'),
      },
    },
  },
  '/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke the refresh token and clear the cookie',
      responses: { 204: ok('Logged out') },
    },
  },
  '/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Current user',
      security: secured,
      responses: {
        200: ok('Current user', {
          type: 'object',
          properties: { user: { $ref: '#/components/schemas/User' } },
        }),
        401: errorResponse('UNAUTHENTICATED'),
      },
    },
  },
};
