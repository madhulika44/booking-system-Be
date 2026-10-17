import { randomInt } from 'node:crypto';

// No 0/O/1/I so refs are easy to read out over the phone
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** e.g. "EVT-7K3Q9P" */
export const generateBookingRef = () => `EVT-${randomCode(6)}`;

/** e.g. "MOCK-4F8K2Q9XTA" */
export const generatePaymentRef = () => `MOCK-${randomCode(10)}`;
