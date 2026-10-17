import type { LayoutInput } from './venues.schemas';

export type CellKind = 'seat' | 'aisle' | 'disabled';

export interface GridCell {
  rowLabel: string;
  seatNumber: number; // 0 for aisles
  gridRow: number;
  gridCol: number;
  kind: CellKind;
}

/** 0 → A, 25 → Z, 26 → AA, 27 → AB … */
export function rowLabelFor(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * Expands each seated zone's rows × cols grid into cells.
 *
 * Row letters CONTINUE across seated zones (Recliner A–B, Gold C–H, …) because a show's seats
 * must satisfy UNIQUE (show_id, row_label, seat_number) — two zones can't both have "A1".
 * Seat numbers restart in each row; aisles take no number, disabled seats keep theirs
 * (they exist physically but are never sold).
 *
 * Returns one cell list per zone, aligned with layout.zones (empty for standing zones).
 */
export function buildLayoutGrid(layout: LayoutInput): GridCell[][] {
  let nextRow = 0;
  return layout.zones.map((zone) => {
    if (zone.type !== 'seated') return [];
    const special = new Map(zone.cells.map((c) => [`${c.row}:${c.col}`, c.kind]));
    const cells: GridCell[] = [];
    for (let r = 1; r <= zone.rows; r++) {
      const rowLabel = rowLabelFor(nextRow++);
      let seatNumber = 0;
      for (let c = 1; c <= zone.cols; c++) {
        const kind: CellKind = special.get(`${r}:${c}`) ?? 'seat';
        if (kind !== 'aisle') seatNumber++;
        cells.push({
          rowLabel,
          seatNumber: kind === 'aisle' ? 0 : seatNumber,
          gridRow: r,
          gridCol: c,
          kind,
        });
      }
    }
    return cells;
  });
}
