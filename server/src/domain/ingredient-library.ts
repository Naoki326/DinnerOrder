import type { Db } from '../db/index.js';
import type {
  Ingredient,
  IngredientConflict,
  IngredientCreate,
  IngredientReferenceCount,
} from '../wire-types.js';
import { listIngredients } from './ingredients.js';

// 线上形状定义在 wire-types.ts（前端也从那里取）
export type { Ingredient, IngredientConflict, IngredientCreate, IngredientReferenceCount } from '../wire-types.js';

/**
 * 食材字典的**写入口**（issue #34；ADR-0012）：录入 / 删。
 *
 * 与只读能力（`domain/ingredients.ts` 的列表、搜索、`contains` 展开、时令集合、`PANTRY_STAPLES`）分开：
 * 那个模块回答「字典里有什么」，这个模块回答「怎么往受控表里加一条、怎么把一条拿掉」。
 * 「改食材」（PATCH + 台账）是 #35 的活，本文件刻意不含它。
 *
 * 三条纪律（ADR-0012）：
 *   * **只有一个必填项**：规范名。别名/时令/「含」是事后按需补的增量。
 *   * **id 由服务端按名称派生**，客户端送来的 id 一律忽略；既有 277 条手写 slug 一律不动。
 *   * **删只在零引用时允许**：6 处 `NO ACTION` 引用（菜谱食材/忌口/爱吃/生熟互换/买菜清单/
 *     「含」指针目标）一处都没提到它才能物理删——判据只有「有没有人用它」。
 */

/** 规范名为空（或纯空白）——「没有名字的食材」不是一条食材 */
export class IngredientNameEmptyError extends Error {
  constructor() {
    super('食材规范名不能为空');
    this.name = 'IngredientNameEmptyError';
  }
}

/**
 * 规范名或别名撞了既有条目。**带上冲突对象**（id + 规范名）——界面据此给出「用这条」，
 * 而不是让掌勺者对着一条做不到的提示自己去找。
 *
 * 撞的可能是规范名，也可能是别人的别名（别名全局唯一：`ingredient_aliases.alias` 是全局主键）。
 */
export class IngredientConflictError extends Error {
  constructor(
    readonly conflict: IngredientConflict,
    readonly field: 'name' | 'alias',
  ) {
    super(`${field === 'name' ? '规范名' : '别名'}「${conflict.name}」已经是字典里的一条：${conflict.id}`);
    this.name = 'IngredientConflictError';
  }
}

/**
 * `contains` 里出现了字典外的目标 → 400，**不静默丢弃**。
 *
 * 静默丢会让「我明明挂了贝类」在界面上看不出任何异常；而这条指针的读众是**忌口硬过滤**，
 * 丢掉一条等于漏排一道菜（ADR-0012 的传播面理由）。
 */
export class IngredientContainsTargetError extends Error {
  constructor(readonly ingredientId: string) {
    super(`「含」指针的目标不在食材字典里：${ingredientId}`);
    this.name = 'IngredientContainsTargetError';
  }
}

/** 字典里没有这条食材（删一条不存在的、或读一条不存在的） */
export class IngredientNotFoundError extends Error {
  constructor(readonly ingredientId: string) {
    super(`食材字典里没有这条：${ingredientId}`);
    this.name = 'IngredientNotFoundError';
  }
}

/**
 * 有引用就不许删（ADR-0012「决定四」）。**报出是哪一类引用、几条**——
 * 界面要说「只能改名」，那不是一句笼统的 409 能说清的。
 */
export class IngredientReferencedError extends Error {
  constructor(
    readonly ingredientId: string,
    readonly references: IngredientReferenceCount[],
  ) {
    super(`这条食材还有人用，不能删：${ingredientId}`);
    this.name = 'IngredientReferencedError';
  }
}

// ---------------------------------------------------------------- 录入

/**
 * 录入一条新食材（ADR-0012「决定二」）：**只有规范名是必填的**。
 *
 * 顺序与 `createRecipe` 同一纪律：先把名字/别名/含指针全部校验过、再把 id 定下来，
 * 最后在一个事务里落库——一次写入里出任何错都不留半截行（半条食材比没有更糟：
 * 它会被忌口/菜谱搜到，却少了别的那几项）。
 */
export function createIngredient(db: Db, input: IngredientCreate): Ingredient {
  const name = input.name.trim();
  if (name === '') throw new IngredientNameEmptyError();

  const aliases = normalizeAliases(input.aliases ?? []);
  const months = normalizeMonths(input.seasonMonths ?? []);
  const contains = normalizeContains(input.contains ?? []);

  // 规范名与别名的冲突都在这一个事务之前判掉：冲突时一个字节都不该写进去
  const nameConflict = findConflict(db, name);
  if (nameConflict) throw new IngredientConflictError(nameConflict, 'name');
  for (const alias of aliases) {
    const conflict = findConflict(db, alias);
    if (conflict) throw new IngredientConflictError(conflict, 'alias');
  }
  // 「含」目标必须在字典里（不静默丢弃）；自指由迁移的 CHECK 兜底，但新条目 id 还没定，
  // 客户端也无法指定，所以这里查不到自指
  for (const target of contains) {
    if (!ingredientExists(db, target)) throw new IngredientContainsTargetError(target);
  }

  const id = deriveIngredientId(db, name);

  const apply = db.transaction((): void => {
    db.prepare('INSERT INTO ingredients (id, name) VALUES (?, ?)').run(id, name);
    const insertAlias = db.prepare('INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES (?, ?)');
    for (const alias of aliases) insertAlias.run(id, alias);
    const insertMonth = db.prepare('INSERT INTO ingredient_season_months (ingredient_id, month) VALUES (?, ?)');
    for (const month of months) insertMonth.run(id, month);
    const insertContains = db.prepare('INSERT INTO ingredient_contains (ingredient_id, contains_id) VALUES (?, ?)');
    for (const target of contains) insertContains.run(id, target);
  });
  apply();

  return ingredientById(db, id)!;
}

/**
 * 新条目的 id 由服务端按名称派生，**客户端不得指定**。
 *
 * 形态照 `library/collectors.ts` 的 `slugOf`（保留汉字、只把会惹麻烦的字符换成 `_`）——
 * 本函数把同一思路用在主键上，再套一个 `ing_` 前缀与既有手写英文 slug 区分。
 * 既有条目的 id 全是手写英文 slug，**本版不回填、不改动**：id 是不可见的主键，两套形态并存无妨。
 *
 * 撞车（同名派生、或派生的串恰好等于某条手写 slug）时加 `_2`、`_3` 递增后缀——
 * 确定性的，且与既有 277 条与未来任何条目都不碰撞。
 */
function deriveIngredientId(db: Db, name: string): string {
  const base = `ing_${slugOf(name)}`;
  const exists = db.prepare('SELECT 1 FROM ingredients WHERE id = ?');
  let candidate = base;
  let suffix = 2;
  while (exists.get(candidate) !== undefined) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * 名字 → id 的 slug 段：与 `library/collectors.ts` 的 `slugOf` 同一思路（保留汉字、
 * 只把会惹麻烦的字符换成 `_`）。
 *
 * **刻意在本文件内重写一遍而不 import `library/collectors.js`**：那个模块 import 了
 * `domain/library.js`，而 `domain` 层再反向 import 它会把「领域 → 采集」的依赖倒过来
 * （采集是更上层的东西）。这个函数只有十行、语义单一，比拆依赖划算。
 */
function slugOf(name: string): string {
  const cleaned = name.replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'ingredient' : cleaned;
}

// ---------------------------------------------------------------- 删

/**
 * 删一条食材（ADR-0012「决定四」）：**只在零引用时允许**。
 *
 * 判据只有一条：**有没有人用它**。这不是权限问题而是完整性：`ingredients.name` 是 UNIQUE、
 * `ingredient_aliases.alias` 是全局主键，删一条会**永久释放一个名字**；放行「反正还没人用」
 * 之外的删除就会把受控表架穿。
 *
 * 先显式查那 6 处引用（`NO ACTION` 外键正是这条规则的执行者），有引用就报出类别与条数，
 * 一处都没有才真删（别名/时令/「含」源的 CASCADE 由外键带走）。
 */
export function deleteIngredient(db: Db, id: string): Ingredient {
  const existing = ingredientById(db, id);
  if (!existing) throw new IngredientNotFoundError(id);

  const references = ingredientReferences(db, id);
  if (references.length > 0) throw new IngredientReferencedError(id, references);

  const apply = db.transaction((): void => {
    db.prepare('DELETE FROM ingredients WHERE id = ?').run(id);
  });
  apply();

  return existing;
}

/**
 * 这条食材被哪些地方引用、各几条（删食材前的完整性检查）。
 *
 * 只报**非零**的类别：零条也在响应里列一排只会让界面要说的话变长。顺序固定（`REQUIRED_TABLES`），
 * 不按数量排——界面上的话要说的是「被谁用着」，不是「哪个用得最多」。
 */
export function ingredientReferences(db: Db, id: string): IngredientReferenceCount[] {
  return REFERENCE_TABLES.map((table) => ({
    kind: table.kind,
    count: countReference(db, table, id),
  })).filter((reference) => reference.count > 0) as IngredientReferenceCount[];
}

/** 6 处引用各一条计数 SQL（列名统一是 `ingredient_id`，只有「含」指针查的是目标那一侧） */
const REFERENCE_TABLES = [
  { kind: 'recipe_ingredients', column: 'ingredient_id', table: 'recipe_ingredients' },
  { kind: 'member_avoid', column: 'ingredient_id', table: 'member_avoid' },
  { kind: 'member_loves', column: 'ingredient_id', table: 'member_loves' },
  { kind: 'exchange_items', column: 'ingredient_id', table: 'exchange_items' },
  { kind: 'grocery_items', column: 'ingredient_id', table: 'grocery_items' },
  // 「含」指针的**目标**那一侧：另一个食材指着它时同样不许删
  { kind: 'ingredient_contains', column: 'contains_id', table: 'ingredient_contains' },
] as const;

function countReference(db: Db, reference: (typeof REFERENCE_TABLES)[number], id: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${reference.table} WHERE ${reference.column} = ?`)
    .get(id) as { count: number };
  return row.count;
}

// ---------------------------------------------------------------- 读单条

/** 按 id 取一条完整食材（与列表接口同一形状）；没有返回 null */
export function ingredientById(db: Db, id: string): Ingredient | null {
  // 复用列表的取数（别名/时令/含指针三张表一次取齐），只按 id 过滤——形状不可能与列表漂移
  return listIngredients(db).find((ingredient) => ingredient.id === id) ?? null;
}

// ---------------------------------------------------------------- 内部工具

/** 字典里有没有这条（`POST` 校验「含」目标、路由判 404 共用这一处） */
export function ingredientExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(id) !== undefined;
}

/** 名字（或别名）撞了谁：先查规范名表，再查别名表——两边都返回冲突对象的 id + 规范名 */
function findConflict(db: Db, candidate: string): IngredientConflict | null {
  const byName = db.prepare('SELECT id, name FROM ingredients WHERE name = ?').get(candidate) as
    | IngredientConflict
    | undefined;
  if (byName) return byName;
  const owner = db
    .prepare(
      `SELECT i.id, i.name FROM ingredient_aliases a JOIN ingredients i ON i.id = a.ingredient_id WHERE a.alias = ?`,
    )
    .get(candidate) as IngredientConflict | undefined;
  return owner ?? null;
}

/** 别名：trim 后去空、去重（同一批里重复给的别名不该让插入互相撞车） */
function normalizeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (alias === '' || seen.has(alias)) continue;
    seen.add(alias);
    result.push(alias);
  }
  return result;
}

/** 时令月份：去重 + 升序（与菜谱的 `seasonMonths` 同一口径）；空数组 = 四季有售（不写月份行） */
function normalizeMonths(months: number[]): number[] {
  return [...new Set(months)].sort((a, b) => a - b);
}

/** 「含」目标：trim 后去空、去重、保序 */
function normalizeContains(contains: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of contains) {
    const target = raw.trim();
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    result.push(target);
  }
  return result;
}
