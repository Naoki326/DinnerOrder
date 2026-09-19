import type { Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import { listIngredients } from '../domain/ingredients.js';

const listQuerySchema = z.object({
  /** 搜索词：同时匹配规范名与别名（模糊） */
  q: z.string().trim().optional(),
});

export function registerIngredientRoutes(api: Hono, deps: AppDeps): void {
  api.get('/ingredients', zodValidator('query', listQuerySchema), (c) => {
    const { q } = c.req.valid('query');
    return c.json({ ingredients: listIngredients(deps.db, q) });
  });
}
