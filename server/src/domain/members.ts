import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import { ingredientExists } from './ingredients.js';
import { recipeExists } from './recipes.js';
import { UnknownMemberError } from './slots.js';
import type {
  LoveEntry,
  LoveTarget,
  MemberCreate,
  MemberProfile,
  ProfileEntry,
  ProfilePatch,
} from '../wire-types.js';

// 线上形状定义在 wire-types.ts（前端也从那里取），领域层自用、也转手给测试与路由
export type { LoveEntry, LoveTarget, MemberCreate, MemberProfile, ProfileEntry, ProfilePatch };

/**
 * 「在用家人」这条谓词（`deleted_at IS NULL`）的**唯一出处**。
 *
 * 软删除（010）把「在不在名单里」变成一个到处都要问的问题：列表、单查、画像编辑的存在性检查、
 * 份量解析、定餐名单校验都要问它。散着写五遍的风险不是打错字（列名就这么长），而是**将来改口径时
 * 漏掉一处**（比如再加 `AND merged_into IS NULL`）——漏掉的那一处会把已删的家人放回某条读/写口，
 * 而且不会有任何测试变红。所以集中成一条常量，各查询自己拼进 WHERE。
 *
 * 不带表名前缀：五处都在 `members` 这一张表上（没有 JOIN 别名场景）。
 * 就地放在本文件而不是新开模块：它只是 `members` 表的一条列事实；代价是 `domain/slots.ts` 会
 * 反向引用本模块（本模块早已引用它的 `UnknownMemberError`），但两边的互相引用都只发生在函数体里，
 * 模块初始化期没有先后依赖。
 */
export const ACTIVE_MEMBERS_PREDICATE = 'deleted_at IS NULL';

/**
 * 四处共用同一句校验文案：zod 形状层、域错误（直接调域时的兜底）、路由层的错误映射。
 * 界面读到的是路由层写出去的那句，形状层那句在表单页就地显示——同一件事在两个出口说两样，
 * 家人就会以为遇上了两个不同的问题。所以文案跟着常量走，不跟出口走。
 */
export const EMPTY_MEMBER_NAME_MESSAGE = '家人的名字不能为空';
export const EMPTY_MEMBER_EMOJI_MESSAGE = '家人的头像不能为空';
export const INVALID_BIRTH_MONTH_MESSAGE = '出生年月必须是 YYYY-MM';
export const MISSING_BIRTH_MONTH_MESSAGE = '小孩必须给出生年月（份量按年龄分带折算）';

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

/**
 * 家人列表：**只给在用的家人**——软删除的那些不出现（这是「删掉 = 从列表消失」的落点：
 * 推荐与换菜的用餐者名单、定餐编辑器的默认名单、切换器都从这一个口取数）。
 * 按种子里定的家庭顺序（sort_order），掌勺者排最前（种子里 `is_cook` 那条排首位）。
 *
 * 刻意**不给** `includeDeleted` 之类的开关：目前全仓没有哪个读口需要含已删的家人
 * （历史名单走 `meal_event_diners` 的姓名快照，份量读历史菜单走 `assumeAdult` 那条路，
 * 两处都不经这里）。将来真要提供「恢复/对账」时再加，且必须是一条显式的口子——
 * 而不是让这个缺省口慢慢变浑。
 */
export function listMembers(db: Db): MemberProfile[] {
  const rows = db
    .prepare(
      `SELECT id, name, emoji, kind, gender, birth_month, is_cook FROM members
        WHERE ${ACTIVE_MEMBERS_PREDICATE}
        ORDER BY sort_order`,
    )
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

/**
 * 单个家人画像；**已删的家人按不存在处理**——与「从列表消失」同一口径，
 * 否则 `GET /members` 与 `GET /members/:id` 会各说各的。
 * 新写的名单/入口也就读不到已删的人（写入口另有一道，见 `resolveDiners`）。
 */
export function findMember(db: Db, id: string): MemberProfile | undefined {
  const row = db
    .prepare(
      `SELECT id, name, emoji, kind, gender, birth_month, is_cook FROM members
        WHERE id = ? AND ${ACTIVE_MEMBERS_PREDICATE}`,
    )
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

/**
 * 按 id 列表解析成员（去重、保持传入顺序）。推荐、换菜、份量三条路都从这里取画像。
 *
 * 两种缺席语义，由调用方按「这个人是谁给的」选：
 *   * `'throw'`（缺省）：名单是**调用方显式给的**，里面出现不存在的人是给错了 → `UnknownMemberError`。
 *   * `'skip'`：名单是**历史快照**（已定菜单的用餐者），成员后来被删了就跳过——与
 *     `portionOf` 的 `missingMembers:'assumeAdult'` 同一个取舍：为一个删掉的家人废掉整次读取，
 *     代价与收益完全不对等（何况他的忌口本来就已随他一起删了）。
 */
export function resolveMembers(
  db: Db,
  ids: string[],
  options: { missing?: 'throw' | 'skip' } = {},
): MemberProfile[] {
  const byId = new Map(listMembers(db).map((member) => [member.id, member]));
  const skip = options.missing === 'skip';
  return [...new Set(ids)].flatMap((memberId) => {
    const member = byId.get(memberId);
    if (member) return [member];
    if (skip) return [];
    throw new UnknownMemberError(memberId);
  });
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
    super(`${INVALID_BIRTH_MONTH_MESSAGE}：${birthMonth}`);
    this.name = 'InvalidBirthMonthError';
  }
}

/** 新增家人时名字空（或只有空白） */
export class EmptyMemberNameError extends Error {
  constructor() {
    super(EMPTY_MEMBER_NAME_MESSAGE);
    this.name = 'EmptyMemberNameError';
  }
}

/** 新增家人时头像空 */
export class EmptyMemberEmojiError extends Error {
  constructor() {
    super(EMPTY_MEMBER_EMOJI_MESSAGE);
    this.name = 'EmptyMemberEmojiError';
  }
}

/** 新增小孩却没给出生年月：折算系数按年龄分带查表，没有它就没有依据（也是 001 的 CHECK） */
export class MissingBirthMonthError extends Error {
  constructor() {
    super(MISSING_BIRTH_MONTH_MESSAGE);
    this.name = 'MissingBirthMonthError';
  }
}

/** 性别只收 male / female（zod 形状层已拦，这里是直接调域时的兑底） */
export class InvalidGenderError extends Error {
  constructor(readonly gender: string) {
    super(`性别只能是 male 或 female，收到：${gender}`);
    this.name = 'InvalidGenderError';
  }
}

const BIRTH_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 改画像（总纲 §2.9）。三块改动在一个事务里落库：
 * 校验失败时一行都不改——画像编辑是最容易半途出错的地方（两张关联表），不能留下半份清单。
 */
export function updateMember(db: Db, id: string, patch: ProfilePatch): MemberProfile {
  const apply = db.transaction((): void => {
    const row = db
      .prepare(`SELECT kind FROM members WHERE id = ? AND ${ACTIVE_MEMBERS_PREDICATE}`)
      .get(id) as { kind: 'adult' | 'child' } | undefined;
    if (!row) throw new MemberNotFoundError(id);

    const now = new Date().toISOString();

    // 姓名/头像：与新增时**同一口径**（trim 后空串拒收）——否则改成一个空名字能把
    // 新增时的校验绕过去，界面上就会出现一个没名字的家人。
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === '') throw new EmptyMemberNameError();
      db.prepare('UPDATE members SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
    }
    if (patch.emoji !== undefined) {
      const emoji = patch.emoji.trim();
      if (emoji === '') throw new EmptyMemberEmojiError();
      db.prepare('UPDATE members SET emoji = ?, updated_at = ? WHERE id = ?').run(emoji, now, id);
    }
    // 性别：入参已由 zod 收敛成二值，领域层作为直接调用路径的兜底再挡一次
    if (patch.gender !== undefined) {
      if (patch.gender !== 'male' && patch.gender !== 'female') throw new InvalidGenderError(patch.gender);
      db.prepare('UPDATE members SET gender = ?, updated_at = ? WHERE id = ?').run(patch.gender, now, id);
    }

    if (patch.birthMonth !== undefined) {
      if (patch.birthMonth === null) {
        if (row.kind === 'child') throw new BirthMonthRequiredError(id);
      } else if (!BIRTH_MONTH_PATTERN.test(patch.birthMonth)) {
        throw new InvalidBirthMonthError(patch.birthMonth);
      }
      db.prepare('UPDATE members SET birth_month = ?, updated_at = ? WHERE id = ?').run(
        patch.birthMonth,
        now,
        id,
      );
    }

    if (patch.avoid !== undefined) replaceAvoid(db, id, dedupe(patch.avoid));
    if (patch.loves !== undefined) replaceLoves(db, id, dedupeTargets(patch.loves));
    // 掌勺者标记（本票起可改）：「家里通常谁做菜」。它不再决定单餐的掌勺者
    // （那是菜单上的 cook），但仍是开 app 缺省身份与新餐槽缺省掌勺者的依据。
    // 允许并列多位（不强制单例），见 wire-types 的 ProfilePatch 注释。
    if (patch.isCook !== undefined) {
      db.prepare('UPDATE members SET is_cook = ?, updated_at = ? WHERE id = ?').run(
        patch.isCook ? 1 : 0,
        now,
        id,
      );
    }
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

// ---------------------------------------------------------------- 新增 / 删除（家人管理）

/**
 * 新增家人的 `id` 生成：`m_` + `randomUUID()`。
 *
 * 为什么不沿用种子的可读 id（`mom` / `dabao`）：那套 id 是人手定的、只为种子服务，
 * 新增入口是运行时路径，得自己造 id——而 `id` 被 `meal_event_diners.member_id`（快照）与
 * `dish_feedback.member_id`（外键）引用，同一个 id 在库里只能有一个主人。
 * 从名字拼音/编号推 id（`laolao` / `member_5`）全都要求「先查重、再决定」，在**并发**下
 * （家里几台手机同时添加）那条「先查后写」的窗口里就会撞上——而撞了就是一个指向别人历史的 id。
 * `crypto.randomUUID()` 由 Node 提供、不引依赖，也永不会与种子撞车（种子不带 `m_` 前缀）。
 * 可读性不靠 id 承担：界面一律显示 `name` / `emoji`。
 */
function newMemberId(): string {
  return `m_${randomUUID()}`;
}

/**
 * 新增家人（本票）。必填项（名字/头像/大人小孩/性别，小孩另加出生年月）由路由层的 zod 先拦一道，
 * 领域层再拦「小孩必须给出生年月」——001 的 CHECK 是最后一道，但那道只有 `kind` 与 `birth_month`，
 * 报出来的错没法翻译成人话；这里先抛出可指认的类型。
 *
 * 排序：`MAX(sort_order) + 1`，新家人排在最后，已有顺序不受扰动。
 * 掌勺者标记恒为 0（用户没要求新增时可选：新增后菜单不重做，掌勺者只能靠画像编辑那套入口改）。
 */
export function createMember(db: Db, input: MemberCreate, clock: Clock): MemberProfile {
  const name = input.name.trim();
  const emoji = input.emoji.trim();
  // 服务端的名字非空校验（客户端表单另有一道）：空白字符串不是名字，但 zod 的 min(1) 拦不住它
  if (name === '') throw new EmptyMemberNameError();
  if (emoji === '') throw new EmptyMemberEmojiError();
  const birthMonth = input.birthMonth ?? null;
  if (birthMonth !== null && !BIRTH_MONTH_PATTERN.test(birthMonth)) {
    throw new InvalidBirthMonthError(birthMonth);
  }
  // 与 updateMember 同一口径：小孩没有出生年月 = 份量分带没有依据（001 的 CHECK 也这么要求）
  if (input.kind === 'child' && birthMonth === null) throw new MissingBirthMonthError();

  const id = newMemberId();
  const now = clock.now().toISOString();
  const insert = db.transaction((): void => {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM members').get() as {
      next: number;
    };
    db.prepare(
      `INSERT INTO members (id, name, emoji, kind, gender, birth_month, is_cook, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(id, name, emoji, input.kind, input.gender, birthMonth, next.next, now, now);
  });
  insert();
  return findMember(db, id)!;
}

/**
 * 删除家人 = **软删除**（本票的决议，见 010 迁移的说明）：打一个 `deleted_at` 时间戳。
 *
 * 行还在、画像条目（`member_avoid` / `member_loves`）也还在，但所有读口都看不到他：
 * `listMembers` 缺省不带已删的，`findMember` 当他不存在。于是：
 *   * 用餐者名单（推荐/换菜/定餐编辑器的默认名单取 `listMembers`）里不再出现他；
 *   * 忌口硬过滤与爱吃软加分随他在 `listMembers` 里消失而自然不再生效；
 *   * `meal_event_diners` 的姓名/头像快照与 `dish_feedback` 的行**一行不动**。
 *
 * 重复删（已删的再删一次）报 404：与「这个人不在家人列表里」同一种语义，不把幂等包装成成功。
 *
 * **为什么不做成幂等 200**（评审提出后复核的决议，保持原样）：
 *   * 与读口一致：`GET /members/:id` 对已删的家人就是 404（「从列表消失」是这一个口说出去的），
 *     若 DELETE 对同一个 id 返回 200 + 画像，调用方就会以为「他还查得到」，两处语义打架。
 *   * 与仓库其余删除一致：取消一餐（`DELETE /slots/:id`）对本来就未定的餐槽报 404 `not_decided`、
 *     撤回反馈（`DELETE /feedback`）对已撤回的那条报 404 `feedback_not_found`——**重复删 = 404**
 *     是本仓库已经统一的口径，单把家人这一处改成幂等，等于让「删除」在三个地方有两条规矩。
 *   * 界面上重复点的真实形态是**另一台设备拿着过期列表**：这时「这位家人不在了，刷新一下页面」
 *     恰好是用户需要知道的事（家人列表在别处变过），而一个静默 200 会让他以为是这台设备删的。
 *   * 家族本机单击不可能双发：家人页的删除是两点式确认，确认键在 `remove.isPending` 期间禁用。
 */
export function deleteMember(db: Db, id: string, clock: Clock): MemberProfile {
  const deletedAt = clock.now().toISOString();
  const apply = db.transaction((): MemberProfile | undefined => {
    // 读的就是「在用的家人」那一份（已删的读不出来，于是重复删自然落到 404）
    const existing = findMember(db, id);
    if (!existing) return undefined;
    db.prepare('UPDATE members SET deleted_at = ?, updated_at = ? WHERE id = ?').run(deletedAt, deletedAt, id);
    return existing;
  });
  const profile = apply();
  if (!profile) throw new MemberNotFoundError(id);
  return profile;
}
