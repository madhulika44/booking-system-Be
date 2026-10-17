import { randomBytes } from 'node:crypto';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Slug with a short random suffix, used when the plain slug is already taken. */
export function uniqueSlug(text: string): string {
  return `${slugify(text)}-${randomBytes(3).toString('hex')}`;
}
