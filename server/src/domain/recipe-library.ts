import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type {
  Recipe,
  RecipeCreate,
  RecipeCuisine,
  RecipeEditRecord,
  RecipeIngredientInput,
  RecipePatch,
  TasteTag,
} from '../wire-types.js';
import { findRecipe } from './recipes.js';
import { findMember, MemberNotFoundError } from './members.js';
import { ingredientExists } from './ingredients.js';
import { RecipeNotFoundError } from './promotion.js';

// 线上形状定义在 wire-types.ts（前端也从那里取）
export type { RecipeCreate, RecipePatch, RecipeEditRecord } from '../wire-types.js';

/**
 * 菜谱库的**写入口**（issue #30；ADR-0009）：录入 / 修订 / 退役 / 还原。
 *
 * 与 `domain/promotion.ts` 的分工：转正改的是**状态与来源信任**（draft → active，外部菜进家庭库），
 * 修订改的是**内容**（转正过的菜照样能改）。两条路都不新建菜谱行——菜谱 id 被菜单、留痕事件、
 * 反馈引用着，换 id 等于把「那道菜」的历史割成两截。
 *
 * **ADR-0009**：掌勺者手写的菜直接 `status='active'` + `source='oral'`（不需要先做过）。
 * 外部数据仍须转正——这条路不接受把草稿转正（那是 `POST /recipes/:id/promotion` 的事）。
 */

/**
 * 已退役的菜不能修订：先用「还原」回到家庭菜谱。
 *
 * **草稿可以修订**（与 `active` 一样）：外部素材的克数（“待重标”）正是掌勺者在菜谱库页面上
 * 手工补的——那是「待处理」真的减少的路径（issue 的 user story 32）。修订**不改状态**，
 * 草稿仍然是草稿，进家庭库仍然要经「上桌 → 转正」（ADR-0006 的门槛一点没动）。
 */
export class RecipeNotEditableError extends Error {
  constructor(
    readonly recipeId: string,
    readonly status: string,
  ) {
    super(`已退役的菜不能直接改，先还原：${recipeId}`);
    this.name = 'RecipeNotEditableError';
  }
}

/** 只有家庭菜谱（active）能退役：草稿本来就不在推荐池里，退役它是一句空话 */
export class RecipeNotActiveError extends Error {
  constructor(
    readonly recipeId: string,
    readonly status: string,
  ) {
    super(`只有家庭菜谱能退役，这道菜当前状态是 ${status}：${recipeId}`);
    this.name = 'RecipeNotActiveError';
  }
}

/** 只有退役的菜能还原 */
export class RecipeNotRetiredError extends Error {
  constructor(
    readonly recipeId: string,
    readonly status: string,
  ) {
    super(`只有已退役的菜能还原，这道菜当前状态是 ${status}：${recipeId}`);
    this.name = 'RecipeNotRetiredError';
  }
}

/** 已经退役的菜不能再退役（幂等地报错，而不是默默成功——界面该刷新） */
export class RecipeAlreadyRetiredError extends Error {
  constructor(readonly recipeId: string) {
    super(`这道菜已经退役了：${recipeId}`);
    this.name = 'RecipeAlreadyRetiredError';
  }
}

/**
 * 克数必须为正。**0 克是「待重标」的存储形态**（迁移 005），不是掌勺者可以手工写的值——
 * 手滑把一道菜踢出推荐池而不自知，是这条规则要挡住的事。界面上的 0 克项显示为空 + 标红 + 不给保存。
 */
export class RecipeIngredientGramsError extends Error {
  constructor(
    readonly ingredientId: string,
    readonly grams: number,
  ) {
    super(`食材 ${ingredientId} 的成人份克数必须大于 0（现在是 ${grams}）`);
    this.name = 'RecipeIngredientGramsError';
  }
}

/** 同上，但报的是**哪个食材名**都没有的空值场景（前端表单里那一行没填） */
export class RecipeIngredientNotFoundError extends Error {
  constructor(readonly ingredientId: string) {
    super(`食材字典里没有这个食材：${ingredientId}`);
    this.name = 'RecipeIngredientNotFoundError';
  }
}

/** 一次修订什么都没改（空 PATCH）——不写台账，也不假装成功 */
export class RecipeNoChangesError extends Error {
  constructor(readonly recipeId: string) {
    super(`这次修订没有任何字段变化：${recipeId}`);
    this.name = 'RecipeNoChangesError';
  }
}

/** 一次修订里重复给了同一个食材（`recipe_ingredients` 的主键是 (recipe_id, ingredient_id)） */
export class RecipeDuplicateIngredientError extends Error {
  constructor(readonly ingredientId: string) {
    super(`食材清单里有重复项：${ingredientId}（同一食材只能出现一次）`);
    this.name = 'RecipeDuplicateIngredientError';
  }
}

/** 空菜名不是一道菜（zod 也会拦，领域层是直接调域时的兜底） */
export class RecipeNameEmptyError extends Error {
  constructor() {
    super('菜名不能为空');
    this.name = 'RecipeNameEmptyError';
  }
}

/** 菜谱 id 生成：`r_` + `randomUUID()`（与家人的 `m_` 前缀同一纪律，永不与种子撞车） */
function newRecipeId(): string {
  return `r_${randomUUID()}`;
}

/**
 * 录入一道新菜（ADR-0009）：`status='active'`、`source='oral'`，录完直接可用。
 *
 * **先校验再落库**（与 `promoteRecipe` 同一顺序纪律）：一次写入里出任何错都不留半截行。
 */
export function createRecipe(db: Db, input: RecipeCreate): Recipe {
  const name = input.name.trim();
  if (name === '') throw new RecipeNameEmptyError();
  assertMember(db, input.memberId);

  const ingredients = normalizeIngredients(db, input.ingredients ?? []);
  const tastes = [...new Set(input.tastes ?? [])];
  const months = [...new Set(input.seasonMonths ?? [])].sort((a, b) => a - b);
  const id = newRecipeId();

  const apply = db.transaction((): void => {
    db.prepare(
      `INSERT INTO recipes (id, name, kind, effort, status, source, cuisine, steps)
       VALUES (?, ?, ?, ?, 'active', 'oral', ?, ?)`,
    ).run(id, name, input.kind, input.effort ?? 'medium', input.cuisine ?? null, input.steps ?? '');
    writeTastes(db, id, tastes);
    writeSeasonMonths(db, id, months);
    writeIngredients(db, id, ingredients);
  });
  apply();

  return findRecipe(db, id)!;
}

/**
 * 修订一道菜（CONTEXT「修订」）：字段级部分更新 + 留痕。
 *
 * **草稿与家庭菜谱都能改；退役的不能**（先用还原）。草稿能改是本票的刻意选择：
 * 外部素材的克数（“待重标”）正是掌勺者在菜谱库页面上手工补的（user story 32）。
 * **修订不改状态**：草稿仍然是草稿，进家庭库仍要经「上桌 + 转正」（ADR-0006 的门槛一点没动）。
 *
 * 留痕按**字段名**记（`changed_fields`）：能回答「改了做法」就够了，不做食材级 diff。
 */
export function patchRecipe(db: Db, clock: Clock, recipeId: string, patch: RecipePatch): Recipe {
  const recipe = findRecipe(db, recipeId);
  if (!recipe) throw new RecipeNotFoundError(recipeId);
  // 草稿能改（补待重标的克数）；退役的要先还原。状态本身不在这条路上（`RecipePatch` 无 status）。
  if (recipe.status === 'retired') throw new RecipeNotEditableError(recipeId, recipe.status);
  assertMember(db, patch.memberId);

  // 先算出「这一次真正变了什么」——空 patch 不写台账（`recipe_edits.changed_fields` 有非空 CHECK）
  const changed: string[] = [];
  const name = patch.name === undefined ? recipe.name : patch.name.trim();
  if (patch.name !== undefined) {
    if (name === '') throw new RecipeNameEmptyError();
    if (name !== recipe.name) changed.push('name');
  }
  if (patch.kind !== undefined && patch.kind !== recipe.kind) changed.push('kind');
  if (patch.effort !== undefined && patch.effort !== recipe.effort) changed.push('effort');
  if (patch.cuisine !== undefined && (patch.cuisine ?? null) !== recipe.cuisine) changed.push('cuisine');
  if (patch.steps !== undefined && patch.steps !== recipe.steps) changed.push('steps');

  const tastes = patch.tastes === undefined ? recipe.tastes : [...new Set(patch.tastes)];
  if (patch.tastes !== undefined && !sameSet(tastes, recipe.tastes)) changed.push('tastes');

  const months =
    patch.seasonMonths === undefined ? recipe.seasonMonths : [...new Set(patch.seasonMonths)].sort((a, b) => a - b);
  if (patch.seasonMonths !== undefined && !sameSet(months, recipe.seasonMonths)) changed.push('seasonMonths');

  // 食材清单：显式传了才替换。`scaling`/`rawCookedAnchor` 未给时**继承原项**
  // （改克数不该顺手把「fixed」「生熟锚点」抹掉——那是别的事）。
  let ingredients = recipe.ingredients.map((item) => ({
    ingredientId: item.ingredientId,
    adultGrams: item.adultGrams,
    scaling: item.scaling,
    rawCookedAnchor: item.rawCookedAnchor,
  }));
  if (patch.ingredients !== undefined) {
    const previous = new Map(recipe.ingredients.map((item) => [item.ingredientId, item]));
    ingredients = normalizeIngredients(db, patch.ingredients).map((item) => ({
      ...item,
      scaling: item.scaling ?? previous.get(item.ingredientId)?.scaling ?? 'linear',
      rawCookedAnchor:
        item.rawCookedAnchor === undefined ? (previous.get(item.ingredientId)?.rawCookedAnchor ?? null) : item.rawCookedAnchor,
    }));
    if (!sameIngredients(ingredients, recipe.ingredients)) changed.push('ingredients');
  }

  if (changed.length === 0) throw new RecipeNoChangesError(recipeId);

  const apply = db.transaction((): void => {
    db.prepare('UPDATE recipes SET name = ?, kind = ?, effort = ?, cuisine = ?, steps = ? WHERE id = ?').run(
      name,
      patch.kind ?? recipe.kind,
      patch.effort ?? recipe.effort,
      patch.cuisine === undefined ? recipe.cuisine : patch.cuisine,
      patch.steps ?? recipe.steps,
      recipeId,
    );
    if (patch.tastes !== undefined) writeTastes(db, recipeId, tastes);
    if (patch.seasonMonths !== undefined) writeSeasonMonths(db, recipeId, months);
    if (patch.ingredients !== undefined) writeIngredients(db, recipeId, ingredients);
    db.prepare(
      `INSERT INTO recipe_edits (recipe_id, edited_at, member_id, changed_fields) VALUES (?, ?, ?, ?)`,
    ).run(recipeId, clock.now().toISOString(), patch.memberId ?? null, changed.join(','));
  });
  apply();

  return findRecipe(db, recipeId)!;
}

/** 退役：`active → retired`。历史（吃过的餐、它的评价）完整保留——退役不等于假装它没存在过。 */
export function retireRecipe(db: Db, clock: Clock, recipeId: string, memberId?: string): Recipe {
  const recipe = findRecipe(db, recipeId);
  if (!recipe) throw new RecipeNotFoundError(recipeId);
  if (recipe.status === 'retired') throw new RecipeAlreadyRetiredError(recipeId);
  // 草稿不能「退役」：它本来就不在推荐池里（ADR-0006 的池子 = active），退役它是一句空话。
  if (recipe.status !== 'active') throw new RecipeNotActiveError(recipeId, recipe.status);
  assertMember(db, memberId);

  const apply = db.transaction((): void => {
    db.prepare(`UPDATE recipes SET status = 'retired' WHERE id = ?`).run(recipeId);
    db.prepare(
      `INSERT INTO recipe_edits (recipe_id, edited_at, member_id, changed_fields) VALUES (?, ?, ?, 'status')`,
    ).run(recipeId, clock.now().toISOString(), memberId ?? null);
  });
  apply();

  return findRecipe(db, recipeId)!;
}

/** 还原：`retired → active`。退役错了不是不可挽回的。 */
export function restoreRecipe(db: Db, clock: Clock, recipeId: string, memberId?: string): Recipe {
  const recipe = findRecipe(db, recipeId);
  if (!recipe) throw new RecipeNotFoundError(recipeId);
  if (recipe.status !== 'retired') throw new RecipeNotRetiredError(recipeId, recipe.status);
  assertMember(db, memberId);

  const apply = db.transaction((): void => {
    db.prepare(`UPDATE recipes SET status = 'active' WHERE id = ?`).run(recipeId);
    db.prepare(
      `INSERT INTO recipe_edits (recipe_id, edited_at, member_id, changed_fields) VALUES (?, ?, ?, 'status')`,
    ).run(recipeId, clock.now().toISOString(), memberId ?? null);
  });
  apply();

  return findRecipe(db, recipeId)!;
}

// ---------------------------------------------------------------- 台账读取

/**
 * 某道菜的修订史（时间倒序）。与 `promotionsOf` 同形、并列——两张表各自回答一个问题
 * （那张：「怎么从外部变成家里的」；这张：「最近被改成什么样」）。
 */
export function recipeEditsOf(db: Db, recipeId: string): RecipeEditRecord[] {
  const rows = db
    .prepare(
      `SELECT e.recipe_id, e.edited_at, e.member_id, m.name AS member_name, e.changed_fields
         FROM recipe_edits e
         LEFT JOIN members m ON m.id = e.member_id
        WHERE e.recipe_id = ?
        ORDER BY e.edited_at DESC, e.id DESC`,
    )
    .all(recipeId) as {
    recipe_id: string;
    edited_at: string;
    member_id: string | null;
    member_name: string | null;
    changed_fields: string;
  }[];

  return rows.map((row) => ({
    recipeId: row.recipe_id,
    editedAt: row.edited_at,
    memberId: row.member_id,
    memberName: row.member_name,
    // 库里存的是逗号分隔的字符串（见迁移 014）；线上形状给数组，按提交顺序原样拆
    changedFields: row.changed_fields === '' ? [] : row.changed_fields.split(','),
  }));
}

// ---------------------------------------------------------------- 内部工具

function assertMember(db: Db, memberId: string | undefined): void {
  if (memberId === undefined) return;
  // 用领域函数而不是手写 SELECT（同一张表的读取只留一个真相；软删的家人也会被这里挡住）
  if (!findMember(db, memberId)) throw new MemberNotFoundError(memberId);
}

/**
 * 食材清单的一次性规整：查字典、查重、克数为正。
 *
 * 不在这里补默认 `scaling`（那是 `createRecipe` / `patchRecipe` 各自继承策略的事）——这里只做
 * 「一份清单本身是否合法」，两处入口共用。
 */
function normalizeIngredients(db: Db, items: RecipeIngredientInput[]): RecipeIngredientInput[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (!ingredientExists(db, item.ingredientId)) throw new RecipeIngredientNotFoundError(item.ingredientId);
    if (item.adultGrams <= 0) throw new RecipeIngredientGramsError(item.ingredientId, item.adultGrams);
    if (seen.has(item.ingredientId)) throw new RecipeDuplicateIngredientError(item.ingredientId);
    seen.add(item.ingredientId);
    return { ...item, adultGrams: roundGrams(item.adultGrams) };
  });
}

/** 口味整体替换（顺序按提交给的先后，与 hydrate 的 rowid 顺序一致） */
function writeTastes(db: Db, recipeId: string, tastes: TasteTag[]): void {
  db.prepare('DELETE FROM recipe_tastes WHERE recipe_id = ?').run(recipeId);
  for (const taste of tastes) {
    db.prepare('INSERT INTO recipe_tastes (recipe_id, taste) VALUES (?, ?)').run(recipeId, taste);
  }
}

/** 适季月份整体替换；空数组 = 四季皆宜（一道菜一行都不写，与种子同一口径） */
function writeSeasonMonths(db: Db, recipeId: string, months: number[]): void {
  db.prepare('DELETE FROM recipe_season_months WHERE recipe_id = ?').run(recipeId);
  for (const month of months) {
    db.prepare('INSERT OR IGNORE INTO recipe_season_months (recipe_id, month) VALUES (?, ?)').run(recipeId, month);
  }
}

/** 食材清单整体替换；位置按提交顺序重排（`position` 有 UNIQUE 约束） */
function writeIngredients(db: Db, recipeId: string, items: RecipeIngredientInput[]): void {
  db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
  items.forEach((item, position) => {
    db.prepare(
      `INSERT INTO recipe_ingredients
         (recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor, source_quantity)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(recipeId, item.ingredientId, position, item.adultGrams, item.scaling ?? 'linear', item.rawCookedAnchor ?? null);
  });
}

/** 克数取一位小数（与转正同一口径：人手写的基准是整洁数字） */
function roundGrams(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 两个集合是否等价（顺序无关；用于判定 tastes / seasonMonths 有没有真变） */
function sameSet(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((item) => set.has(item));
}

/** 两份食材清单是否等价（顺序 + 逐项克数/缩放/锚点；用于判定 ingredients 有没有真变） */
function sameIngredients(a: RecipeIngredientInput[], b: Recipe['ingredients']): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const before = b[index]!;
    return (
      item.ingredientId === before.ingredientId &&
      item.adultGrams === before.adultGrams &&
      (item.scaling ?? 'linear') === before.scaling &&
      (item.rawCookedAnchor ?? null) === before.rawCookedAnchor
    );
  });
}

// `RecipeCuisine` 只用作类型（`RecipePatch.cuisine`），显式 re-export 便于路由层引用
export type { RecipeCuisine };
