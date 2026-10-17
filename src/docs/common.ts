export const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

export const jsonBody = (properties: Record<string, unknown>, required: string[] = []) => ({
  required: true,
  content: {
    'application/json': { schema: { type: 'object', properties, required } },
  },
});

export const ok = (description: string, schema?: unknown) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
});

export const uuidParam = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

export const queryParam = (name: string, schema: unknown, description?: string) => ({
  name,
  in: 'query',
  required: false,
  schema,
  ...(description ? { description } : {}),
});

export const paginationParams = [
  queryParam('page', { type: 'integer', minimum: 1, default: 1 }),
  queryParam('limit', { type: 'integer', minimum: 1, maximum: 50, default: 12 }),
];

export const secured = [{ bearerAuth: [] }];
