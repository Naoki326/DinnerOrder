import type { Db } from '../db/index.js';
import type { Ingredient, IngredientRef } from '../wire-types.js';

// 线上形状定义在 wire-types.ts（前端也从那里取）
export type { Ingredient };

interface IngredientRow {
  id: string;
  name: string;
}

interface AliasRow {
  ingredient_id: string;
  alias: string;
}

interface SeasonRow {
  ingredient_id: string;
  month: number;
}

interface ContainsRow {
  ingredient_id: string;
  contains_id: string;
}

/**
 * 列出食材字典；`q` 同时匹配规范名与别名（画像编辑里挑食材用）。
 * 别名命中也要能选中——家人说「西红柿」，字典里叫「番茄」。
 */
export function listIngredients(db: Db, query?: string): Ingredient[] {
  const keyword = query?.trim();
  const rows = keyword
    ? (db
        .prepare(
          // 命名参数：`?1` 形式在 better-sqlite3 的 .all() 下会与重复绑定打架，命名参数两处引用同一值
          `SELECT id, name FROM ingredients
            WHERE name LIKE :like ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM ingredient_aliases a
                           WHERE a.ingredient_id = ingredients.id AND a.alias LIKE :like ESCAPE '\\')
            ORDER BY name`,
        )
        .all({ like: `%${escapeLike(keyword)}%` }) as IngredientRow[])
    : (db.prepare('SELECT id, name FROM ingredients ORDER BY name').all() as IngredientRow[]);

  if (rows.length === 0) return [];

  const placeholders = rows.map(() => '?').join(', ');
  const params = rows.map((row) => row.id);
  // 一次把别名/时令月份/「含」指针取齐，避免 N+1（字典是几十行量级，IN 列表开销无虞）。
  // 顺序按录入先后（rowid）：种子/维护时把最常用的叫法写在前面，界面就直接照此展示。
  const aliasRows = db
    .prepare(
      `SELECT ingredient_id, alias FROM ingredient_aliases
        WHERE ingredient_id IN (${placeholders}) ORDER BY rowid`,
    )
    .all(...params) as AliasRow[];

  const aliasesByIngredient = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = aliasesByIngredient.get(row.ingredient_id);
    if (list) list.push(row.alias);
    else aliasesByIngredient.set(row.ingredient_id, [row.alias]);
  }

  const seasonRows = db
    .prepare(
      `SELECT ingredient_id, month FROM ingredient_season_months
        WHERE ingredient_id IN (${placeholders}) ORDER BY month`,
    )
    .all(...params) as SeasonRow[];
  const monthsByIngredient = new Map<string, number[]>();
  for (const row of seasonRows) {
    const list = monthsByIngredient.get(row.ingredient_id);
    if (list) list.push(row.month);
    else monthsByIngredient.set(row.ingredient_id, [row.month]);
  }

  const containsByIngredient = containsRefs(db, rows.map((row) => row.id));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    aliases: aliasesByIngredient.get(row.id) ?? [],
    seasonMonths: monthsByIngredient.get(row.id) ?? [],
    contains: containsByIngredient.get(row.id) ?? [],
  }));
}

/**
 * 隐性忌口「含」指针的直接目标（如蚝油 → 贝类）。
 * 只返回**直接**指针，不递归展开：递归展开的语义是「这道菜是否命中忌口」，
 * 属于菜谱忌口推导（recipe.avoidIngredientIds 给的是展开后的并集）与推荐期过滤，
 * 字典条目上挂着「间接含」徒增歧义（蚝油含豆瓣酱？不是——蚝油含的是贝类）。
 */
function containsRefs(db: Db, ingredientIds: string[]): Map<string, IngredientRef[]> {
  const placeholders = ingredientIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ic.ingredient_id, ic.contains_id, i.name
         FROM ingredient_contains ic JOIN ingredients i ON i.id = ic.contains_id
        WHERE ic.ingredient_id IN (${placeholders})
        ORDER BY i.rowid`,
    )
    .all(...ingredientIds) as { ingredient_id: string; contains_id: string; name: string }[];
  const grouped = new Map<string, IngredientRef[]>();
  for (const row of rows) {
    const list = grouped.get(row.ingredient_id);
    const ref: IngredientRef = { ingredientId: row.contains_id, name: row.name };
    if (list) list.push(ref);
    else grouped.set(row.ingredient_id, [ref]);
  }
  return grouped;
}

/** LIKE 里的通配符按字面处理（`%`/`_` 是家人真会输错的字符，不能当通配符放过去） */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 食材是否存在——忌口/爱吃条目落库前校验，避免脏外键（总纲：字典是全库唯一受控表） */
export function ingredientExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(id) !== undefined;
}

/**
 * 隐性忌口「含」指针的递归展开（蚝油含贝类、贝类若还含什么就继续）。
 * 表里只存直接指针，展开在这里做一次、给全体调用方用（菜谱忌口推导与推荐期硬过滤同一口径）。
 * 深度优先 + visited：指针表理论上能有环（A 含 B、B 含 A），展开不能因此死循环。
 */
export function expandContains(db: Db): Map<string, string[]> {
  const rows = db.prepare('SELECT ingredient_id, contains_id FROM ingredient_contains').all() as ContainsRow[];
  const direct = new Map<string, string[]>();
  for (const row of rows) {
    const list = direct.get(row.ingredient_id);
    if (list) list.push(row.contains_id);
    else direct.set(row.ingredient_id, [row.contains_id]);
  }

  const expanded = new Map<string, string[]>();
  for (const start of direct.keys()) {
    const seen = new Set<string>();
    const stack = [...(direct.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(direct.get(next) ?? []));
    }
    expanded.set(start, [...seen]);
  }
  return expanded;
}
