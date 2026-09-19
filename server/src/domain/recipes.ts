import type { Db } from '../db/index.js';
import { expandContains } from './ingredients.js';
import type { Recipe, RecipeIngredient, RecipeStatus, TasteTag } from '../wire-types.js';

// 线上形状定义在 wire-types.ts（前端也从那里取）
export type { Recipe, RecipeIngredient };

interface RecipeRow {
  id: string;
  name: string;
  kind: Recipe['kind'];
  effort: Recipe['effort'];
  status: RecipeStatus;
  source: Recipe['source'];
  cuisine: Recipe['cuisine'];
  steps: string;
}

/** 菜谱列的一处选择：`listRecipes` / `findRecipe` / 导入器都要 SELECT 同一组列（多了就漂移） */
const RECIPE_COLUMNS = 'id, name, kind, effort, status, source, cuisine, steps';

interface IngredientRow {
  recipe_id: string;
  ingredient_id: string;
  name: string;
  adult_grams: number;
  scaling: RecipeIngredient['scaling'];
  raw_cooked_anchor: string | null;
}

interface NamedRow {
  recipe_id: string;
  name: string;
}

interface MonthRow {
  recipe_id: string;
  month: number;
}

/**
 * 列出菜谱。缺省只给**转正态**（推荐池的唯一来源，总纲 §2.8）；管理/选菜界面可按 status 查草稿/退役，
 * 或传 'all' 一次拿齐。
 */
export function listRecipes(db: Db, status: RecipeStatus | 'all' = 'active'): Recipe[] {
  const rows =
    status === 'all'
      ? (db.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes ORDER BY rowid`).all() as RecipeRow[])
      : (db.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE status = ? ORDER BY rowid`).all(status) as RecipeRow[]);
  return hydrate(db, rows);
}

export function findRecipe(db: Db, id: string): Recipe | undefined {
  const row = db.prepare(`SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = ?`).get(id) as RecipeRow | undefined;
  if (!row) return undefined;
  return hydrate(db, [row])[0];
}

/**
 * 这道菜里有没有「待重标」的食材项（`adult_grams = 0`）。
 *
 * 0 克不是错误也不是「零克食材」，而是**导入期的显式状态**（迁移 005：模糊份量等 LLM 重标）。
 * 它对份量引擎与买菜清单都是一个未定的数（乘出来就是 0 g），所以在给「要算克数的地方」
 * 供菜之前把它拦在外面：推荐/换菜的候选池不收（重标成功后克数变正数，状态自然消失），
 * 而它在报告里仍看得见（`relabel.pending`）。
 *
 * 收口一处的理由：这是同一个状态在两个入口的共同语义（整餐推荐的外部补位池、换菜候选池），
 * 散在各处就会漏。日后新增「拿菜去算克数」的入口，也要过这里。
 *
 * 只判**有没有** 0 克项，不判状态：调用侧自己决定要不要限草稿（家庭菜谱是掌勺者自己录的，
 * 不该被这条规则挡在推荐外）。
 */
export function hasPendingRelabel(recipe: Recipe): boolean {
  return recipe.ingredients.some((item) => item.adultGrams <= 0);
}

export function recipeExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(id) !== undefined;
}

/** 一次把关联表取齐再拼装，避免每道菜四条查询的 N+1 */
function hydrate(db: Db, rows: RecipeRow[]): Recipe[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  const params = ids as (string | number)[];

  const aliases = group(db, `SELECT recipe_id, alias AS name FROM recipe_aliases WHERE recipe_id IN (${placeholders}) ORDER BY rowid`, params);
  // 口味顺序按录入先后（rowid）：种子/维护时怎么写的就怎么展示，不按字符序随机排列
  const tastes = group(db, `SELECT recipe_id, taste AS name FROM recipe_tastes WHERE recipe_id IN (${placeholders}) ORDER BY rowid`, params);
  const months = db
    .prepare(`SELECT recipe_id, month FROM recipe_season_months WHERE recipe_id IN (${placeholders}) ORDER BY month`)
    .all(...params) as MonthRow[];

  const ingredientRows = db
    .prepare(
      `SELECT ri.recipe_id, ri.ingredient_id, i.name, ri.adult_grams, ri.scaling, ri.raw_cooked_anchor
         FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id IN (${placeholders}) ORDER BY ri.recipe_id, ri.position`,
    )
    .all(...params) as IngredientRow[];

  const ingredientsByRecipe = new Map<string, RecipeIngredient[]>();
  for (const row of ingredientRows) {
    const list = ingredientsByRecipe.get(row.recipe_id);
    const item: RecipeIngredient = {
      ingredientId: row.ingredient_id,
      name: row.name,
      adultGrams: row.adult_grams,
      scaling: row.scaling,
      rawCookedAnchor: row.raw_cooked_anchor,
    };
    if (list) list.push(item);
    else ingredientsByRecipe.set(row.recipe_id, [item]);
  }

  const monthsByRecipe = new Map<string, number[]>();
  for (const row of months) {
    const list = monthsByRecipe.get(row.recipe_id);
    if (list) list.push(row.month);
    else monthsByRecipe.set(row.recipe_id, [row.month]);
  }

  // 忌口关联现算（总纲 §3「食材清单推导 + 隐性忌口」）：清单里的食材 ∪「含」指针递归展开的结果。
  // 不落列的理由见迁移 002 的说明：食材或指针一改，落列就要同步维护，那正是会漂移的地方。
  const expanded = expandContains(db);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    aliases: aliases.get(row.id) ?? [],
    kind: row.kind,
    tastes: (tastes.get(row.id) ?? []) as TasteTag[],
    seasonMonths: monthsByRecipe.get(row.id) ?? [],
    avoidIngredientIds: [
      ...new Set(
        (ingredientsByRecipe.get(row.id) ?? []).flatMap((item) => [item.ingredientId, ...(expanded.get(item.ingredientId) ?? [])]),
      ),
    ],
    effort: row.effort,
    status: row.status,
    source: row.source,
    cuisine: row.cuisine,
    steps: row.steps,
    ingredients: ingredientsByRecipe.get(row.id) ?? [],
  }));
}

/** 分组小工具：把 `<某 id, 名称>` 形态的行按 id 收成数组 */
function group(db: Db, sql: string, params: (string | number)[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of db.prepare(sql).all(...params) as NamedRow[]) {
    const list = grouped.get(row.recipe_id);
    if (list) list.push(row.name);
    else grouped.set(row.recipe_id, [row.name]);
  }
  return grouped;
}
