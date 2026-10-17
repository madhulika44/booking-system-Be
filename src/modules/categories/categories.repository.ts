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

// ---------- admin ----------

export interface CategoryWithCount extends Category {
  eventCount: number;
}

export async function listCategoriesWithCounts(): Promise<CategoryWithCount[]> {
  const { rows } = await pool.query<Category & { event_count: number }>(
    `SELECT c.id, c.name, c.slug, COUNT(e.id)::int AS event_count
     FROM categories c LEFT JOIN events e ON e.category_id = c.id
     GROUP BY c.id
     ORDER BY c.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, eventCount: r.event_count }));
}

export async function findCategory(id: string): Promise<Category | undefined> {
  const { rows } = await pool.query<Category>(
    'SELECT id, name, slug FROM categories WHERE id = $1',
    [id],
  );
  return rows[0];
}

export async function insertCategory(name: string, slug: string): Promise<Category> {
  const { rows } = await pool.query<Category>(
    'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id, name, slug',
    [name, slug],
  );
  return rows[0]!;
}

export async function updateCategory(id: string, name: string, slug: string): Promise<Category> {
  const { rows } = await pool.query<Category>(
    'UPDATE categories SET name = $2, slug = $3 WHERE id = $1 RETURNING id, name, slug',
    [id, name, slug],
  );
  return rows[0]!;
}

export async function deleteCategory(id: string): Promise<void> {
  await pool.query('DELETE FROM categories WHERE id = $1', [id]);
}
