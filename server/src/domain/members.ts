import type { Db } from '../db/index.js';
import { ingredientExists } from './ingredients.js';
import { recipeExists } from './recipes.js';
import type { LoveEntry, LoveTarget, MemberProfile, ProfileEntry, ProfilePatch } from '../wire-types.js';

// 线上形状定义在 wire-types.ts（前端也从那里取），领域层自用、也转手给测试与路由
export type { LoveEntry, LoveTarget, MemberProfile, ProfileEntry, ProfilePatch };

interface MemberRow {
  id: string;
  name: string;
  emoji: string;
  kind: 'adult' | 'child';
  gender: 'male' | 'female';
  birth_month: string | null;
  is_cook: number;
}

interface IngredientEntryRow {
  member_id: string;
  ingredient_id: string;
  name: string;
}

interface LoveRow {
  member_id: string;
  ingredient_id: string | null;
  recipe_id: string | null;
  ingredient_name: string | null;
  recipe_name: string | null;
}

// 爱吃是**混合粒度**（总纲 §2.9）：一条恰好指向一个食材或一道菜。这条 JOIN 把两种目标的
// 规范名一次取齐（外连接，一侧必然是 NULL）；顺序按录入先后（rowid）。
const LOVES_SELECT = `SELECT ml.member_id, ml.ingredient_id, ml.recipe_id,
                             i.name AS ingredient_name, r.name AS recipe_name
                        FROM member_loves ml
                        LEFT JOIN ingredients i ON i.id = ml.ingredient_id
                        LEFT JOIN recipes r ON r.id = ml.recipe_id`;

/** 家人列表：按种子里定的家庭顺序（sort_order）。掌勺者排最前（种子里 is_cook 那条排首位） */
export function listMembers(db: Db): MemberProfile[] {
  const rows = db
    .prepare('SELECT id, name, emoji, kind, gender, birth_month, is_cook FROM members ORDER BY sort_order')
    .all() as MemberRow[];
  if (rows.length === 0) return [];

  const avoid = entriesByMember(
    db,
    `SELECT ma.member_id, ma.ingredient_id, i.name
       FROM member_avoid ma JOIN ingredients i ON i.id = ma.ingredient_id
      ORDER BY ma.rowid`,
  );

  const loves = new Map<string, LoveEntry[]>();
  for (const row of db.prepare(`${LOVES_SELECT} ORDER BY ml.rowid`).all() as LoveRow[]) {
    const entry = toLoveEntry(row);
    const list = loves.get(row.member_id);
    if (list) list.push(entry);
    else loves.set(row.member_id, [entry]);
  }

  return rows.map((row) => toProfile(row, avoid.get(row.id) ?? [], loves.get(row.id) ?? []));
}

export function findMember(db: Db, id: string): MemberProfile | undefined {
  const row = db
    .prepare('SELECT id, name, emoji, kind, gender, birth_month, is_cook FROM members WHERE id = ?')
    .get(id) as MemberRow | undefined;
  if (!row) return undefined;

  const avoid = db
    .prepare(
      `SELECT ma.ingredient_id, i.name
         FROM member_avoid ma JOIN ingredients i ON i.id = ma.ingredient_id
        WHERE ma.member_id = ? ORDER BY ma.rowid`,
    )
    .all(id) as Omit<IngredientEntryRow, 'member_id'>[];
  const loves = db
    .prepare(`${LOVES_SELECT} WHERE ml.member_id = ? ORDER BY ml.rowid`)
    .all(id) as LoveRow[];

  return toProfile(
    row,
    avoid.map((entry) => ({ ingredientId: entry.ingredient_id, name: entry.name })),
    loves.map(toLoveEntry),
  );
}

function toLoveEntry(row: LoveRow): LoveEntry {
  if (row.ingredient_id !== null) {
    return { kind: 'ingredient', id: row.ingredient_id, name: row.ingredient_name! };
  }
  return { kind: 'recipe', id: row.recipe_id!, name: row.recipe_name! };
}

function entriesByMember(db: Db, sql: string): Map<string, ProfileEntry[]> {
  const grouped = new Map<string, ProfileEntry[]>();
  for (const row of db.prepare(sql).all() as IngredientEntryRow[]) {
    const entry = { ingredientId: row.ingredient_id, name: row.name };
    const list = grouped.get(row.member_id);
    if (list) list.push(entry);
    else grouped.set(row.member_id, [entry]);
  }
  return grouped;
}

function toProfile(row: MemberRow, avoid: ProfileEntry[], loves: LoveEntry[]): MemberProfile {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    kind: row.kind,
    gender: row.gender,
    birthMonth: row.birth_month,
    isCook: row.is_cook === 1,
    avoid,
    loves,
  };
}

/** 家人不存在 */
export class MemberNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`家人不存在：${id}`);
    this.name = 'MemberNotFoundError';
  }
}

/** 小孩被清空出生年月 */
export class BirthMonthRequiredError extends Error {
  constructor(readonly id: string) {
    super(`小孩必须保留出生年月：${id}`);
    this.name = 'BirthMonthRequiredError';
  }
}

/** 条目指向字典里不存在的食材 */
export class UnknownIngredientError extends Error {
  constructor(readonly ingredientId: string) {
    super(`食材字典里没有这个食材：${ingredientId}`);
    this.name = 'UnknownIngredientError';
  }
}

/** 爱吃条目指向不存在的菜谱（#15 接通菜粒度后新增的入口，同样拒绝脏数据） */
export class UnknownRecipeError extends Error {
  constructor(readonly recipeId: string) {
    super(`菜谱库里没有这道菜：${recipeId}`);
    this.name = 'UnknownRecipeError';
  }
}

/** 出生年月格式非法（只收 'YYYY-MM'） */
export class InvalidBirthMonthError extends Error {
  constructor(readonly birthMonth: string) {
    super(`出生年月必须是 YYYY-MM：${birthMonth}`);
    this.name = 'InvalidBirthMonthError';
  }
}

const BIRTH_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 改画像（总纲 §2.9）。三块改动在一个事务里落库：
 * 校验失败时一行都不改——画像编辑是最容易半途出错的地方（两张关联表），不能留下半份清单。
 */
export function updateMember(db: Db, id: string, patch: ProfilePatch): MemberProfile {
  const apply = db.transaction((): void => {
    const row = db.prepare('SELECT kind FROM members WHERE id = ?').get(id) as { kind: 'adult' | 'child' } | undefined;
    if (!row) throw new MemberNotFoundError(id);

    if (patch.birthMonth !== undefined) {
      if (patch.birthMonth === null) {
        if (row.kind === 'child') throw new BirthMonthRequiredError(id);
      } else if (!BIRTH_MONTH_PATTERN.test(patch.birthMonth)) {
        throw new InvalidBirthMonthError(patch.birthMonth);
      }
      db.prepare('UPDATE members SET birth_month = ?, updated_at = ? WHERE id = ?').run(
        patch.birthMonth,
        new Date().toISOString(),
        id,
      );
    }

    if (patch.avoid !== undefined) replaceAvoid(db, id, dedupe(patch.avoid));
    if (patch.loves !== undefined) replaceLoves(db, id, dedupeTargets(patch.loves));
  });

  apply();
  return findMember(db, id)!;
}

/** 清单是集合不是流水：重复条目只留第一次出现的位置 */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** 同上，爱吃是混合粒度：按「粒度 + id」判重（食材 tomato 与菜谱 tomato 是两条不同的条目） */
function dedupeTargets(targets: LoveTarget[]): LoveTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 整体替换忌口清单；先验食材存在，避免留下指向空处的画像条目 */
function replaceAvoid(db: Db, memberId: string, ingredientIds: string[]): void {
  for (const ingredientId of ingredientIds) {
    if (!ingredientExists(db, ingredientId)) throw new UnknownIngredientError(ingredientId);
  }
  db.prepare('DELETE FROM member_avoid WHERE member_id = ?').run(memberId);
  const insert = db.prepare('INSERT INTO member_avoid (member_id, ingredient_id, created_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const ingredientId of ingredientIds) insert.run(memberId, ingredientId, now);
}

/** 整体替换爱吃清单；两种粒度各自验存在（食材查字典、菜查菜谱） */
function replaceLoves(db: Db, memberId: string, targets: LoveTarget[]): void {
  for (const target of targets) {
    if (target.kind === 'ingredient') {
      if (!ingredientExists(db, target.id)) throw new UnknownIngredientError(target.id);
    } else if (!recipeExists(db, target.id)) {
      throw new UnknownRecipeError(target.id);
    }
  }
  db.prepare('DELETE FROM member_loves WHERE member_id = ?').run(memberId);
  const insert = db.prepare(
    'INSERT INTO member_loves (member_id, ingredient_id, recipe_id, created_at) VALUES (?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  for (const target of targets) {
    insert.run(memberId, target.kind === 'ingredient' ? target.id : null, target.kind === 'recipe' ? target.id : null, now);
  }
}
