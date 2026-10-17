import { pool } from '../../config/db';

export interface Category {
  id: string;
  name: string;
  slug: string;
}

export async function listCategories(): Promise<Category[]> {
  const { rows } = await pool.query<Category>(
    'SELECT id, name, slug FROM categories ORDER BY name',
  );
  return rows;
}
