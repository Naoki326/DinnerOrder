import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import { listIngredients } from '../domain/ingredients.js';
import {
  createIngredient,
  deleteIngredient,
  ingredientEditsOf,
  ingredientById,
  ingredientReferences,
  ingredientExists,
  patchIngredient,
  IngredientConflictError,
  IngredientContainsTargetError,
  IngredientNameEmptyError,
  IngredientNoChangesError,
  IngredientNotFoundError,
  IngredientReferencedError,
  IngredientSelfContainsError,
} from '../domain/ingredient-library.js';
import { MemberNotFoundError } from '../domain/members.js';

/**
 * 食材字典（issue #34/#35；ADR-0012）：从**只读**变成**能录、能改、能删**。
 *
 * 两个写动作 + 一个台账读口：录入 / 改（PATCH + 台账）/ 删。「含」提议是 #37 的活，不在这里。
 *
 * 词汇按 `CONTEXT.md`：**录入食材 / 改食材 / 删食材**，不用「加食材」（那是菜谱行里的动作）、
 * 也不用「编辑食材」（CONTEXT 明写为 Avoid）。
 */
const listQuerySchema = z.object({
  /** 搜索词：同时匹配规范名与别名（模糊） */
  q: z.string().trim().optional(),
});

/** 规范名长度上限：够长地放下一个复合调料的叫法，但挡得住贴进去一整段话 */
const maxNameLength = 60;

/**
 * 录入入参：**只有 `name` 必填**（ADR-0012「决定二」），其余三个都可空。
 *
 * 三个刻意的形状选择：
 *   * `.trim().min(1)` 放在形状层：纯空白串（`'   '`）在 zod 的 `min(1)` 眼里是合法字符串，
 *     但它就是一个空名字——服务端的非空校验要在这一层真的生效（与 `members.ts` 同一纪律）。
 *   * `contains` 收的是**食材 id 数组**：目标必须是字典里的条目，客户端送名字来就会
 *     在别名/错别字上对不上。id 的合法性在领域层判（越界 → 400，不静默丢弃）。
 *   * `id` **不在** schema 里（zod 会剥掉多余键）：客户端指定 id 被忽略，id 由服务端按名称派生。
 */
const createSchema = z.object({
  name: z.string().trim().min(1, '食材规范名不能为空').max(maxNameLength, `规范名最多 ${maxNameLength} 字`),
  // 别名与「含」目标都先 trim 再查非空：纯空白串在 `min(1)` 眼里是合法字符串，但它既不是别名也不是目标
  aliases: z.array(z.string().trim().min(1, '别名不能是空白')).optional(),
  seasonMonths: z.array(z.number().int().min(1).max(12)).optional(),
  contains: z.array(z.string().trim().min(1, '「含」的目标不能是空白')).optional(),
});

/**
 * 改食材入参（issue #35）：与 `createSchema` 同为四个字段，但**全部可空**（部分更新）。
 *
 * 传了的块整体替换；没传的保持原样。四个字段一个都没变时领域层报 409（`no_changes`）。
 * `name` 在这里仍要 `trim().min(1)`：空名字在形状层就拦住（与录入同一纪律）。
 */
const patchSchema = z.object({
  name: z.string().trim().min(1, '食材规范名不能为空').max(maxNameLength, `规范名最多 ${maxNameLength} 字`).optional(),
  aliases: z.array(z.string().trim().min(1, '别名不能是空白')).optional(),
  seasonMonths: z.array(z.number().int().min(1).max(12)).optional(),
  contains: z.array(z.string().trim().min(1, '「含」的目标不能是空白')).optional(),
  /** 谁改的（界面送当前身份，进台账）；不传 = 不记名 */
  memberId: z.string().min(1).optional(),
});

export function registerIngredientRoutes(api: Hono, deps: AppDeps): void {
  api.get('/ingredients', zodValidator('query', listQuerySchema), (c) => {
    const { q } = c.req.valid('query');
    return c.json({ ingredients: listIngredients(deps.db, q) });
  });

  /**
   * **录入一条新食材**（ADR-0012）。录完立刻能被菜谱引用、被忌口指向——没有「审核」这一步。
   *
   * 成功 201 返回**完整的食材线上形状**（与列表接口同一形状），调用方不必再查一次。
   */
  api.post('/ingredients', zodValidator('json', createSchema), (c) => {
    try {
      return c.json({ ingredient: createIngredient(deps.db, c.req.valid('json')) }, 201);
    } catch (error) {
      return ingredientWriteError(c, error);
    }
  });

  /**
   * 这条食材被哪些地方引用、各几条（删之前先问清楚）。
   *
   * 与 `DELETE` 共用同一份领域判定（`ingredientReferences`）：界面拿它决定「给删除按钮还是给说明」，
   * 而两个接口不可能对「有没有人用它」看法不一致。不存在的食材走同一条 404。
   */
  api.get('/ingredients/:id/references', (c) => {
    const id = c.req.param('id');
    // 先确认存在（否则 404），再拿引用清单
    if (!ingredientExists(deps.db, id)) return c.json({ error: 'not_found', id }, 404);
    return c.json({ id, references: ingredientReferences(deps.db, id) });
  });

  /**
   * 这条食材的**改动台账**（CONTEXT「改食材」；issue #35）：时间倒序，含改动人。
   *
   * 与 `GET /recipes/:id/edits` 同形、并列。不存在的食材 → 404（不是空台账）。
   */
  api.get('/ingredients/:id/edits', (c) => {
    const id = c.req.param('id');
    if (!ingredientById(deps.db, id)) return c.json({ error: 'not_found', id }, 404);
    return c.json({ edits: ingredientEditsOf(deps.db, id) });
  });

  /**
   * **改一条食材**（CONTEXT「改食材」；ADR-0012「决定三」）：字段级部分更新 + 留痕。
   *
   * **PATCH 而不是 PUT**：改食材是部分更新、且每次改都留痕（与 `PATCH /recipes/:id` 同一思路）。
   * 改名**天然跟随**引用方：本仓没有名称快照，菜谱详情/买菜清单/忌口显示都读同一条 `ingredients` 行。
   * 四个字段一个都没变 → 409 `no_changes`（不写台账、也不假装成功）。
   */
  api.patch('/ingredients/:id', zodValidator('json', patchSchema), (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ ingredient: patchIngredient(deps.db, deps.clock, id, c.req.valid('json')) });
    } catch (error) {
      return ingredientWriteError(c, error);
    }
  });

  /**
   * **删一条食材**（ADR-0012「决定四」）：零引用才成功，有引用 → 409 且**报出是哪一类引用、几条**。
   *
   * 物理删而不是软删：这条动作要的正是「名字被释放、以后能重新建」（ADR-0012 的 Further Notes）。
   */
  api.delete('/ingredients/:id', (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ ok: true, ingredient: deleteIngredient(deps.db, id) });
    } catch (error) {
      return ingredientWriteError(c, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx。每种失败都告诉掌勺者下一步做什么：
 *   * 400 `invalid_request`：zod 已拦在前面（名字空/纯空白、月份越界、别名空白）
 *   * 409 `ingredient_conflict`：名字或别名撞了既有条目——**带冲突对象**，界面据此「用这条」
 *   * 400 `unknown_contains_target`：`contains` 里有字典外的 id（**不静默丢弃**）
 *   * 400 `self_contains`：把自己挂成自己的「含」目标（改食材这条路才会遇到）
 *   * 404 `not_found`：这条不在字典里了（界面该刷新）
 *   * 409 `ingredient_referenced`：还有人用它——**报出是哪一类、几条**，界面说「只能改名」
 *   * 409 `no_changes`：这次提交四个字段一个都没变（不写台账，也不假装成功）
 *
 * 与 `recipeWriteError` / `groceryError` 同一纪律：**共用领域错误类型，不共用响应映射**
 * （对外报的字段名与上下文跟着本路由的入参走）。
 */
function ingredientWriteError(c: Context, error: unknown): Response {
  if (error instanceof IngredientNameEmptyError) {
    return c.json({ error: 'invalid_request', issues: [{ path: 'name', message: error.message }] }, 400);
  }
  if (error instanceof IngredientConflictError) {
    return c.json({ error: 'ingredient_conflict', field: error.field, conflict: error.conflict }, 409);
  }
  if (error instanceof IngredientContainsTargetError) {
    return c.json({ error: 'unknown_contains_target', ingredientId: error.ingredientId }, 400);
  }
  if (error instanceof IngredientSelfContainsError) {
    return c.json({ error: 'self_contains', ingredientId: error.ingredientId }, 400);
  }
  if (error instanceof IngredientNotFoundError) {
    return c.json({ error: 'not_found', id: error.ingredientId }, 404);
  }
  if (error instanceof IngredientReferencedError) {
    return c.json({ error: 'ingredient_referenced', id: error.ingredientId, references: error.references }, 409);
  }
  if (error instanceof IngredientNoChangesError) {
    return c.json({ error: 'no_changes', id: error.ingredientId }, 409);
  }
  if (error instanceof MemberNotFoundError) {
    return c.json({ error: 'unknown_member', memberId: error.id }, 400);
  }
  throw error;
}
