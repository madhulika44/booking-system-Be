import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

export const venueIdParamsSchema = z.object({ id: z.uuid() });
export const layoutIdParamsSchema = z.object({ id: z.uuid() });

export const createVenueSchema = z.object({
  name: text(120),
  address: text(300),
  city: text(80),
});

export const updateVenueSchema = createVenueSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to update' });

// ---------- layouts ----------

export const MAX_GRID_ROWS = 26;
export const MAX_GRID_COLS = 60;

const cellSchema = z.strictObject({
  row: z.number().int().min(1),
  col: z.number().int().min(1),
  /** Only non-seat cells are listed; every other cell in the grid is a seat. */
  kind: z.enum(['aisle', 'disabled']),
});

const standingZoneSchema = z.strictObject({
  name: text(60),
  type: z.literal('standing'),
  capacity: z.number().int().min(1).max(100_000),
});

const seatedZoneSchema = z.strictObject({
  name: text(60),
  type: z.literal('seated'),
  rows: z.number().int().min(1).max(MAX_GRID_ROWS),
  cols: z.number().int().min(1).max(MAX_GRID_COLS),
  cells: z
    .array(cellSchema)
    .max(MAX_GRID_ROWS * MAX_GRID_COLS)
    .default([]),
});

export const layoutSchema = z
  .object({
    name: text(80),
    zones: z
      .array(z.discriminatedUnion('type', [standingZoneSchema, seatedZoneSchema]))
      .min(1)
      .max(10),
  })
  .superRefine((layout, ctx) => {
    const names = new Set<string>();
    layout.zones.forEach((zone, i) => {
      const key = zone.name.toLowerCase();
      if (names.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['zones', i, 'name'],
          message: 'Zone names must be unique',
        });
      }
      names.add(key);

      if (zone.type !== 'seated') return;
      const seen = new Set<string>();
      zone.cells.forEach((cell, j) => {
        if (cell.row > zone.rows || cell.col > zone.cols) {
          ctx.addIssue({
            code: 'custom',
            path: ['zones', i, 'cells', j],
            message: 'Cell is outside the grid',
          });
        }
        const pos = `${cell.row}:${cell.col}`;
        if (seen.has(pos)) {
          ctx.addIssue({
            code: 'custom',
            path: ['zones', i, 'cells', j],
            message: 'Duplicate cell',
          });
        }
        seen.add(pos);
      });
      if (seen.size >= zone.rows * zone.cols) {
        ctx.addIssue({
          code: 'custom',
          path: ['zones', i],
          message: 'A seated zone needs at least one seat',
        });
      }
    });
  });

export type CreateVenueInput = z.infer<typeof createVenueSchema>;
export type UpdateVenueInput = z.infer<typeof updateVenueSchema>;
export type LayoutInput = z.infer<typeof layoutSchema>;
