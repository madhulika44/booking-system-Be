/** Money is always integer paise. These helpers exist so floats never sneak in. */

export function assertPaise(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid paise amount: ${value}`);
  }
  return value;
}

export function rupeesToPaise(rupees: number): number {
  return assertPaise(Math.round(rupees * 100));
}

/** For logs/seed output only — the UI does its own ₹ formatting. */
export function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}
