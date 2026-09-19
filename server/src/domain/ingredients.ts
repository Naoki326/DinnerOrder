import type { Db } from '../db/index.js';
import type { Ingredient } from '../wire-types.js';

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
  // 一次把别名取齐，避免 N+1（字典是几十行量级，IN 列表开销无虞）。
  // 顺序按录入先后（rowid）：种子/维护时把最常用的叫法写在前面，界面就直接照此展示。
  const aliasRows = db
    .prepare(
      `SELECT ingredient_id, alias FROM ingredient_aliases
        WHERE ingredient_id IN (${placeholders}) ORDER BY rowid`,
    )
    .all(...rows.map((row) => row.id)) as AliasRow[];

  const aliasesByIngredient = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = aliasesByIngredient.get(row.ingredient_id);
    if (list) list.push(row.alias);
    else aliasesByIngredient.set(row.ingredient_id, [row.alias]);
  }

  return rows.map((row) => ({ id: row.id, name: row.name, aliases: aliasesByIngredient.get(row.id) ?? [] }));
}

/** LIKE 里的通配符按字面处理（`%`/`_` 是家人真会输错的字符，不能当通配符放过去） */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 食材是否存在——忌口/爱吃条目落库前校验，避免脏外键（总纲：字典是全库唯一受控表） */
export function ingredientExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(id) !== undefined;
}
