import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import type { RecipeCuisine } from '../wire-types.js';
import { findRecipe, listRecipes } from '../domain/recipes.js';
import {
  createRecipe,
  patchRecipe,
  recipeEditsOf,
  RecipeAlreadyRetiredError,
  RecipeDuplicateIngredientError,
  RecipeIngredientGramsError,
  RecipeIngredientNotFoundError,
  RecipeNameEmptyError,
  RecipeNoChangesError,
  RecipeNotActiveError,
  RecipeNotEditableError,
  RecipeNotRetiredError,
  restoreRecipe,
  retireRecipe,
} from '../domain/recipe-library.js';
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
import { importRecipe, ImportSourceError, ImportStructureError } from '../domain/recipe-import.js';

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

/** 荤素汤位 / 难度 / 口味 / 月份的值域：与迁移 002/005/006 的 CHECK 同源，只此一处 */
const KINDS = ['meat', 'veg', 'soup_meat', 'soup_veg'] as const;
const EFFORTS = ['quick', 'medium', 'heavy'] as const;
const TASTES = ['甜', '辣', '酸', '咸鲜', '清淡'] as const;

/** 修订/录入里的一项食材：只给字典 id + 克数（规范名由字典决定，客户端送的名字不作数） */
const ingredientInputSchema = z.object({
  ingredientId: z.string().min(1),
  /** 必须为正：0 克是「待重标」的存储形态（迁移 005），不是掌勺者能手工写的值 */
  adultGrams: z.number().positive('克数必须大于 0'),
  scaling: z.enum(['linear', 'fixed']).optional(),
  rawCookedAnchor: z.string().nullable().optional(),
});

const maxNameLength = 60;

/** 来源链接/说明的长度上限：够长地放下一个带 xsec_token 的分享链，但挡得住贴进去一整页 HTML */
const maxSourceRefLength = 500;

/** 粘贴文字的素材长度上限：与 `import/extract.ts` 的 `MAX_SOURCE_TEXT_LENGTH` 同源口径 */
const maxImportTextLength = 20_000;

/** `POST /recipes` 入参：name + kind 必填，其余缺省即可用（见 `RecipeCreate` 的注释） */
const recipeCreateSchema = z.object({
  name: z.string().trim().min(1, '菜名不能为空').max(maxNameLength, `菜名最多 ${maxNameLength} 字`),
  kind: z.enum(KINDS),
  effort: z.enum(EFFORTS).optional(),
  cuisine: z.enum(CUISINES).nullable().optional(),
  tastes: z.array(z.enum(TASTES)).optional(),
  seasonMonths: z.array(z.number().int().min(1).max(12)).optional(),
  steps: z.string().optional(),
  ingredients: z.array(ingredientInputSchema).optional(),
  memberId: z.string().min(1).optional(),
  /**
   * 原始来源（迁移 015）：贴链接/贴文字导入后的落库把链接记在这里。
   * 手写录入不传（没有可回填的单一链接——硬编一个就是编数据）。
   */
  sourceRef: z.string().trim().max(maxSourceRefLength, `来源最多 ${maxSourceRefLength} 字`).optional(),
});

/**
 * `POST /recipes/import` 入参（issue #32）：来源素材二选一。
 *
 * 链接只收 **http(s)**：`zod` 的 `.url()` 连 `file://` 也放行（实测），而服务端会真的去 fetch
 * 它——所以这里额外钉一道协议闸门。**不认平台域名**：小红书/下厨房都没有公开接口，
 * 取正文那条路自己会失败并报 `fetch_failed`；这里只需挡住非网络协议。
 */
const recipeImportSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('url'),
      url: z
        .string()
        .trim()
        .url('要一个完整的 http(s) 链接')
        .refine((value) => /^https?:\/\//i.test(value), '只支持 http / https 链接'),
    }),
    z.object({
      kind: z.literal('text'),
      text: z.string().trim().min(1, '文字不能为空').max(maxImportTextLength, `文字最多 ${maxImportTextLength} 字`),
    }),
  ]),
  memberId: z.string().min(1).optional(),
});

/** `PATCH /recipes/:id` 入参：部分更新（未传的块保持原样），**状态不在这里** */
const recipePatchSchema = recipeCreateSchema.partial();

/** 退役/还原的入参（谁点的，进台账）；两条动词路径共用 */
const statusActionSchema = z.object({ memberId: z.string().min(1).optional() });

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

  /**
   * 某道菜的**修订**台账（CONTEXT「修订」；ADR-0009）。与 `/promotions` 并列但不同表：
   * 那张回答「怎么从外部变成家里的」，这张回答「最近被改成什么样」。
   */
  api.get('/recipes/:id/edits', (c) => {
    const recipe = findRecipe(deps.db, c.req.param('id'));
    if (!recipe) return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
    return c.json({ edits: recipeEditsOf(deps.db, recipe.id) });
  });

  /**
   * 掌勺者**录入一道新菜**（ADR-0009）：直接 `status='active'`、`source='oral'`，录完就能定餐与推荐。
   *
   * 为什么不复用 `POST /recipes/:id/promotion` 那条路：转正是「把外部菜改写成家里版本」，
   * 必带 LLM 改写与「上过桌」的门槛；手写的菜本来就已是家里版本，没有可改写的对象。
   */
  api.post('/recipes', zodValidator('json', recipeCreateSchema), (c) => {
    try {
      return c.json({ recipe: createRecipe(deps.db, c.req.valid('json')) }, 201);
    } catch (error) {
      return recipeWriteError(c, '', error);
    }
  });

  /**
   * 掌勺者**修订一道菜**（CONTEXT「修订」）：字段级部分更新 + 留痕。
   *
   * **PATCH 而不是 PUT**：修订是部分更新、且要留痕；与 `POST .../promotion` 把动作写进路径同一思路。
   */
  api.patch('/recipes/:id', zodValidator('json', recipePatchSchema), (c) => {
    const recipeId = c.req.param('id');
    try {
      return c.json({ recipe: patchRecipe(deps.db, deps.clock, recipeId, c.req.valid('json')) });
    } catch (error) {
      return recipeWriteError(c, recipeId, error);
    }
  });

  /**
   * 把来源素材**结构化成一份预填编辑器**（issue #32）。
   *
   * 三条形状上的刻意选择：
   *   * **不落库**：产出是预览，掌勺者校对后走 `POST /recipes`。于是「LLM 产出的东西没被看过
   *     就进库」在形状上不可能发生（ADR-0006 的门槛、ADR-0011 的信任根）。
   *   * **`POST` 而不是 `GET`**：它带正文、要调 LLM、有副作用（花钱、耗时），不是一次「读」。
   *     做成 `GET` 会让浏览器/代理缓存一个会变的预览。
   *   * **动词在路径上**（`/recipes/import`）：这是「把一段素材变成一道菜」的动作，
   *     不是「提交一份菜谱资源」（那是 `POST /recipes`）。
   *
   * 失败映射看 `recipeImportError`：取不到正文 → 400（换一种输入）、结构化失败 → 502（重试）。
   */
  api.post('/recipes/import', zodValidator('json', recipeImportSchema), async (c) => {
    try {
      const preview = await importRecipe(deps.db, deps.llm, c.req.valid('json').source);
      return c.json({ preview });
    } catch (error) {
      return recipeImportError(c, error);
    }
  });

  /**
   * **退役**：`active → retired`，历史保留。
   *
   * 做成动词路径而不是 `PATCH { status }`：状态机不是用户的表单字段，可任意选的下拉
   * 会让「draft→active」那条 ADR-0006 核心门槛变成用户能绕过的开关。
   */
  api.post('/recipes/:id/retire', zodValidator('json', statusActionSchema), (c) => {
    const recipeId = c.req.param('id');
    try {
      return c.json({ recipe: retireRecipe(deps.db, deps.clock, recipeId, c.req.valid('json').memberId) });
    } catch (error) {
      return recipeWriteError(c, recipeId, error);
    }
  });

  /** **还原**：`retired → active`（退役错了不是不可挽回的），同样走动词路径 */
  api.post('/recipes/:id/restore', zodValidator('json', statusActionSchema), (c) => {
    const recipeId = c.req.param('id');
    try {
      return c.json({ recipe: restoreRecipe(deps.db, deps.clock, recipeId, c.req.valid('json').memberId) });
    } catch (error) {
      return recipeWriteError(c, recipeId, error);
    }
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

/**
 * 菜谱写接口（录入 / 修订 / 退役 / 还原）的领域错误 → 明确的 4xx。
 *
 * 每种失败都要告诉掌勺者下一步做什么：
 *   * 404 `not_found`：这道菜不在库里（界面该刷新）
 *   * 400 `unknown_member`：身份对不上家人列表
 *   * 409 `not_active` / `not_editable` / `not_retired` / `already_retired`：状态机不允许这个动作（界面该刷新）
 *   * 400 `ingredient_grams` / `unknown_ingredient` / `duplicate_ingredient`：清单这一项不合法
 *   * 400 `no_changes`：这一次提交什么都没改（不写台账，也不假装成功）
 *   * 400 `invalid_request`：zod 已拦在前面（名字空、克数非正、值域不对）
 *
 * 与 `promotionError` 同一纪律：**共用领域错误类型，不共用响应映射**（对外报的字段名与
 * 上下文跟着本路由的入参走）。
 */
function recipeWriteError(c: Context, recipeId: string, error: unknown): Response {
  if (error instanceof RecipeNotFoundError) return c.json({ error: 'not_found', id: recipeId }, 404);
  if (error instanceof MemberNotFoundError) return c.json({ error: 'unknown_member', memberId: error.id }, 400);
  if (error instanceof RecipeNotActiveError) {
    return c.json({ error: 'not_active', id: error.recipeId, status: error.status }, 409);
  }
  if (error instanceof RecipeNotEditableError) {
    return c.json({ error: 'not_editable', id: error.recipeId, status: error.status }, 409);
  }
  if (error instanceof RecipeNotRetiredError) {
    return c.json({ error: 'not_retired', id: error.recipeId, status: error.status }, 409);
  }
  if (error instanceof RecipeAlreadyRetiredError) return c.json({ error: 'already_retired', id: error.recipeId }, 409);
  if (error instanceof RecipeIngredientGramsError) {
    return c.json({ error: 'ingredient_grams', ingredientId: error.ingredientId, grams: error.grams }, 400);
  }
  if (error instanceof RecipeIngredientNotFoundError) {
    return c.json({ error: 'unknown_ingredient', ingredientId: error.ingredientId }, 400);
  }
  if (error instanceof RecipeDuplicateIngredientError) {
    return c.json({ error: 'duplicate_ingredient', ingredientId: error.ingredientId }, 400);
  }
  if (error instanceof RecipeNoChangesError) return c.json({ error: 'no_changes', id: error.recipeId }, 400);
  if (error instanceof RecipeNameEmptyError) return c.json({ error: 'invalid_request', issues: [{ path: 'name', message: '菜名不能为空' }] }, 400);
  throw error;
}

/**
 * 导入失败 → 明确的 4xx/5xx。两种失败对应**两种下一步**，所以分开报：
 *
 *   * 400 `fetch_failed`：取不到那个链接（平台改版/要登录/网络）。掌勺者的下一步是
 *     **换一种输入**（贴文字），所以把成功的那条路写在错误里（`reason` 带上原错误类型）。
 *   * 400 `source_too_short`：素材太短，看不出是一道菜。下一步是**把做法贴全**。
 *   * 502 `structure_failed`：LLM 没成（不可用/形状不合）。库里什么都没变，可以重试；
 *     `notes` 带上失败细节（不静默）。
 *
 * 与 `promotionError` / `recipeWriteError` 同一口径：**共用领域错误类型，不共用响应映射**
 * （对外报的字段名与上下文跟着本路由的入参走）。
 */
function recipeImportError(c: Context, error: unknown): Response {
  if (error instanceof ImportSourceError) {
    const tooShort = error.reason === 'SourceTooShortError';
    return c.json({ error: tooShort ? 'source_too_short' : 'fetch_failed', reason: error.reason, message: error.message }, 400);
  }
  if (error instanceof ImportStructureError) {
    return c.json({ error: 'structure_failed', notes: error.notes }, 502);
  }
  throw error;
}
