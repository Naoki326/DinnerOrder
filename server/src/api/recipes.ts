import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import type { RecipeCuisine } from '../wire-types.js';
import { findRecipe, listRecipes } from '../domain/recipes.js';
import { recipeDetail } from '../domain/nutrition.js';
import {
  MAX_DIFFERENCES_LENGTH,
  promoteRecipe,
  PromotionRewriteFailedError,
  RecipeNotDraftError,
  RecipeNotFoundError,
  RecipeNotServedError,
  promotionsOf,
} from '../domain/promotion.js';
import { MemberNotFoundError } from '../domain/members.js';
import { CUISINES } from '../llm/import-schema.js';

/**
 * 菜谱库（总纲 §2.8）。缺省只列**转正态**——那是推荐池的唯一来源；
 * 管理界面要看草稿/退役时才带 `status`。
 *
 * 本票补上唯一的**写接口**：转正（`POST /recipes/:id/promotion`）。转正之外仍然没有
 * 「直接改菜谱」的路——掌勺者的编辑一律经转正这条带留痕的路（总纲 §2.8「治理：编辑留痕」）。
 *
 * 不改用 `PUT /recipes/:id`：转正的语义不是「替换一份资源」，而是「对这一道菜做一次有 LLM
 * 参与、有门槛（必须已上桌）、有留痕的动作」——`POST .../promotion` 把这三件事都写在路径上。
 */
const listQuerySchema = z.object({
  /** 缺省只列转正态（推荐池的唯一来源）；'all' 给选菜器用（转过的菜、外部补位菜都要能选） */
  status: z.enum(['draft', 'active', 'retired', 'all']).default('active'),
});

/** 转正入参：口述差异 + 掌勺者校对的菜系 + 谁点的（当前身份，进台账） */
const promotionSchema = z.object({
  /**
   * 口述差异（「多点辣、不放蒜」）；可空——没口述也要转正（待重标的项仍需重标）。
   * 长度上限从领域常量取（与 `MAX_DIFFERENCES_LENGTH` 同一个来源，不手写 500）：
   * 这是**唯一**一道门槛——超长报 400，而不是默默截断（领域层不再 slice）。
   */
  differences: z.string().max(MAX_DIFFERENCES_LENGTH, `口述差异最多 ${MAX_DIFFERENCES_LENGTH} 字`).optional(),
  /** 菜系参考 tag 的校对（总纲 §2.8）：值域与迁移 005 的 CHECK 同源（`CUISINES` 是唯一来源） */
  cuisine: z.enum(CUISINES).optional(),
  /** 谁点的转正（界面送当前身份）；不传 = 不记名 */
  memberId: z.string().min(1).optional(),
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

  /**
   * 一道菜的食谱（本票）：做法步骤自由文本 + 食材清单（成人份基准）。
   *
   * 为什么单独一条路径而不是给 `GET /recipes/:id` 加个 `?with=steps`：本接口服务的是
   * **站在灶台前的掌勺者**（步骤 + 清单，一屏做完），与「菜谱资源本身」是两种读法；
   * 拼在同一个响应里会让菜谱管理列表也不得不读一遍没人看的自由文本。
   * `steps` 为空串时**照原样返回**（家庭菜里确实有没写做法的），界面自己表达「还没写做法」。
   */
  api.get('/recipes/:id/recipe', (c) => {
    const recipeId = c.req.param('id');
    try {
      return c.json({ recipe: recipeDetail(deps.db, recipeId) });
    } catch (error) {
      if (error instanceof RecipeNotFoundError) return c.json({ error: 'not_found', id: recipeId }, 404);
      throw error;
    }
  });

  /**
   * 某道菜的转正台账（编辑留痕，总纲 §2.8）。
   * 放在 `GET /recipes/:id` 之外而不是内嵌：台账可能多条、且与菜谱本体是两种读取语义。
   */
  api.get('/recipes/:id/promotions', (c) => {
    const recipe = findRecipe(deps.db, c.req.param('id'));
    if (!recipe) return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
    return c.json({ promotions: promotionsOf(deps.db, recipe.id) });
  });

  api.post('/recipes/:id/promotion', zodValidator('json', promotionSchema), async (c) => {
    const recipeId = c.req.param('id');
    try {
      const body = c.req.valid('json');
      const promotion = await promoteRecipe(deps.db, deps.clock, deps.llm, recipeId, {
        differences: body.differences,
        cuisine: body.cuisine as RecipeCuisine | undefined,
        memberId: body.memberId,
      });
      return c.json({ promotion });
    } catch (error) {
      return promotionError(c, recipeId, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx/5xx。每种失败都要让掌勺者知道下一步做什么：
 *   * 404 `not_found`：这道菜不在库里（界面该刷新）
 *   * 409 `not_draft`：已经转过了 / 已退役
 *   * 400 `recipe_not_served`：还没上桌——**先去把它做一顿**（ADR-0006 的门槛）
 *   * 400 `unknown_member`：身份对不上家人列表
 *   * 502 `rewrite_failed`：LLM 没改成，草稿原样留着，可以重试
 *
 * `unknown_member` 与 `api/feedback.ts` 的 `feedbackError` 是同一个形状，**刻意不共用**：
 * 与 `portionError` / `bookingError` 同一口径——共用领域错误类型，不共用响应映射
 * （对外报的字段名与上下文跟着本路由的入参走）。
 */
function promotionError(c: Context, recipeId: string, error: unknown): Response {
  if (error instanceof RecipeNotFoundError) return c.json({ error: 'not_found', id: recipeId }, 404);
  if (error instanceof RecipeNotDraftError) {
    return c.json({ error: 'not_draft', id: recipeId, status: error.status }, 409);
  }
  if (error instanceof RecipeNotServedError) return c.json({ error: 'recipe_not_served', id: recipeId }, 400);
  if (error instanceof MemberNotFoundError) return c.json({ error: 'unknown_member', memberId: error.id }, 400);
  if (error instanceof PromotionRewriteFailedError) {
    return c.json({ error: 'rewrite_failed', id: recipeId, notes: error.notes }, 502);
  }
  throw error;
}
