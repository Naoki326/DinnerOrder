import type { Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import { findRecipe, listRecipes } from '../domain/recipes.js';

/**
 * 菜谱库（总纲 §2.8）。缺省只列**转正态**——那是推荐池的唯一来源；
 * 管理界面要看草稿/退役时才带 `status`。本票不做菜谱的写接口（转正/编辑属后续工单）。
 */
const listQuerySchema = z.object({
  /** 缺省只列转正态（推荐池的唯一来源）；'all' 给选菜器用（转过的菜、外部补位菜都要能选） */
  status: z.enum(['draft', 'active', 'retired', 'all']).default('active'),
});

export function registerRecipeRoutes(api: Hono, deps: AppDeps): void {
  api.get('/recipes', zodValidator('query', listQuerySchema), (c) => {
    const { status } = c.req.valid('query');
    return c.json({ recipes: listRecipes(deps.db, status) });
  });

  api.get('/recipes/:id', (c) => {
    const recipe = findRecipe(deps.db, c.req.param('id'));
    if (!recipe) return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
    return c.json({ recipe });
  });
}
