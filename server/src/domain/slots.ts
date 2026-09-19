import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type {
  BookingSource,
  DinerRef,
  LlmCallMeta,
  MealEvent,
  MealEventType,
  MealKind,
  MealSlot,
  MenuDish,
  RecipeKind,
  RecentDish,
  SlotBooking,
} from '../wire-types.js';
import { findRecipe } from './recipes.js';
import { addDays, familyDate, familyInstant, MEAL_CUTOFF_HOUR, parseDate } from './family-time.js';

// 线上形状定义在 wire-types.ts（前端也从那里取）
export type { DinerRef, MealEvent, MealSlot, MenuDish, RecentDish };

/** 餐槽 id = 家庭时区日历日期 × 餐次（'2025-06-02:lunch'） */
export function slotId(date: string, meal: MealKind): string {
  return `${date}:${meal}`;
}

export function parseSlotId(id: string): { date: string; meal: MealKind } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}):(lunch|dinner)$/.exec(id);
  if (!match) return undefined;
  if (!parseDate(match[1]!)) return undefined;
  return { date: match[1]!, meal: match[2] as MealKind };
}

interface EventRow {
  seq: number;
  slot_id: string;
  slot_date: string;
  meal: MealKind;
  type: MealEventType;
  source: BookingSource;
  occurred_at: string;
  llm_model: string | null;
  llm_prompt_version: string | null;
  llm_latency_ms: number | null;
  llm_degraded: number | null;
}

interface DinersRow {
  seq: number;
  member_id: string;
  member_name: string;
  member_emoji: string;
}

interface DishesRow {
  seq: number;
  position: number;
  recipe_id: string;
  recipe_name: string;
  recipe_kind: RecipeKind;
  keep_leftover: number;
}

// ---------------------------------------------------------------- 判定（全部经注入时钟）

/** 这一餐是否已经过了截止时刻（过了就当它已经上桌：不再可定、不再可改、进「最近吃过」窗口） */
export function hasMealPassed(clock: Clock, date: string, meal: MealKind): boolean {
  const now = clock.now();
  if (date < familyDate(now)) return true;
  if (date > familyDate(now)) return false;
  return now.getTime() >= familyInstant(date, MEAL_CUTOFF_HOUR[meal]).getTime();
}

/** 家庭时区的今天 */
export function todayOf(clock: Clock): string {
  return familyDate(clock.now());
}

// ---------------------------------------------------------------- 事件流 → 当前状态

/**
 * 折叠事件流得出餐槽的当前状态（ADR-0007）：某餐槽**最后一条**事件说了算，
 * 取消事件把餐槽退回未定。没有事件 = 未定。
 */
export function foldSlot(db: Db, clock: Clock, date: string, meal: MealKind): MealSlot {
  const history = listSlotEvents(db, slotId(date, meal));
  return toSlot(clock, date, meal, history);
}

function toSlot(clock: Clock, date: string, meal: MealKind, history: MealEvent[]): MealSlot {
  const last = history[history.length - 1];
  const decided = last !== undefined && last.type !== 'cancel';
  return {
    id: slotId(date, meal),
    date,
    meal,
    status: decided ? 'decided' : 'undecided',
    menu: decided ? { diners: last.diners, dishes: last.dishes } : null,
    editable: !hasMealPassed(clock, date, meal),
  };
}

/** 某餐槽的全部留痕（按发生顺序）——「为什么推这道 / 为什么没推」的回溯入口 */
export function listSlotEvents(db: Db, id: string): MealEvent[] {
  const rows = db
    .prepare(
      `SELECT seq, slot_id, slot_date, meal, type, source, occurred_at,
              llm_model, llm_prompt_version, llm_latency_ms, llm_degraded
         FROM meal_events WHERE slot_id = ? ORDER BY seq`,
    )
    .all(id) as EventRow[];
  if (rows.length === 0) return [];

  const params = rows.map((row) => row.seq);
  const placeholders = params.map(() => '?').join(', ');
  const diners = new Map<number, DinerRef[]>();
  for (const row of db
    .prepare(
      `SELECT seq, member_id, member_name, member_emoji FROM meal_event_diners
        WHERE seq IN (${placeholders}) ORDER BY seq, position`,
    )
    .all(...params) as DinersRow[]) {
    const list = diners.get(row.seq);
    const ref: DinerRef = { memberId: row.member_id, name: row.member_name, emoji: row.member_emoji };
    if (list) list.push(ref);
    else diners.set(row.seq, [ref]);
  }

  const dishes = new Map<number, MenuDish[]>();
  for (const row of db
    .prepare(
      `SELECT d.seq, d.position, d.recipe_id, r.name AS recipe_name, r.kind AS recipe_kind, d.keep_leftover
         FROM meal_event_dishes d JOIN recipes r ON r.id = d.recipe_id
        WHERE d.seq IN (${placeholders}) ORDER BY d.seq, d.position`,
    )
    .all(...params) as DishesRow[]) {
    const list = dishes.get(row.seq);
    const dish: MenuDish = {
      recipeId: row.recipe_id,
      name: row.recipe_name,
      kind: row.recipe_kind,
      keepLeftover: row.keep_leftover === 1,
    };
    if (list) list.push(dish);
    else dishes.set(row.seq, [dish]);
  }

  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    occurredAt: row.occurred_at,
    source: row.source,
    diners: diners.get(row.seq) ?? [],
    dishes: dishes.get(row.seq) ?? [],
    llm: llmMeta(row),
  }));
}

function llmMeta(row: EventRow): LlmCallMeta | null {
  if (row.llm_model === null) return null;
  return {
    model: row.llm_model,
    promptVersion: row.llm_prompt_version!,
    latencyMs: row.llm_latency_ms!,
    degraded: row.llm_degraded === 1,
  };
}

// ---------------------------------------------------------------- 列表

/**
 * 主界面「下一餐优先」的取数：从今天起逐日排午/晚。今天如果已经过完了（晚餐也过了），
 * 窗口整体后移一天——「下一餐」列表不该因为今天过完就空掉（那时最近的未定餐在明天）。
 * 已过截止时刻的餐次不列，已在列的已定餐照常返回（下面那几张卡要看得到订了什么）。
 */
export function listUpcomingSlots(db: Db, clock: Clock, days: number): MealSlot[] {
  const today = todayOf(clock);
  // 晚餐过了则今天什么也不剩（午餐截止更早，必然也过了）
  const start = hasMealPassed(clock, today, 'dinner') ? addDays(today, 1) : today;
  const dates = Array.from({ length: days }, (_, offset) => addDays(start, offset));
  const history = eventsBySlot(db, dates[0]!, dates[dates.length - 1]!);
  const slots: MealSlot[] = [];
  for (const date of dates) {
    for (const meal of ['lunch', 'dinner'] as const) {
      const slot = toSlot(clock, date, meal, history.get(slotId(date, meal)) ?? []);
      if (slot.editable) slots.push(slot);
    }
  }
  return slots;
}

/** 一次取齐日期区间内每个餐槽的全部事件（逐餐折叠时不必再查库） */
function eventsBySlot(db: Db, from: string, to: string): Map<string, MealEvent[]> {
  const ids = db
    .prepare('SELECT DISTINCT slot_id FROM meal_events WHERE slot_date BETWEEN ? AND ? ORDER BY slot_id')
    .all(from, to) as { slot_id: string }[];
  return new Map(ids.map(({ slot_id }) => [slot_id, listSlotEvents(db, slot_id)]));
}

// ---------------------------------------------------------------- 定餐 / 改餐 / 取消

/** 餐槽已过截止时刻（午 14:00 / 晚 21:00，家庭时区）——不能再定/改 */
export class SlotPassedError extends Error {
  constructor(readonly id: string) {
    super(`这一餐已经过了：${id}`);
    this.name = 'SlotPassedError';
  }
}

/** 取消一个本来就没定的餐槽 */
export class SlotNotDecidedError extends Error {
  constructor(readonly id: string) {
    super(`这一餐还没有定：${id}`);
    this.name = 'SlotNotDecidedError';
  }
}

/** 餐槽 id 格式非法 */
export class InvalidSlotIdError extends Error {
  constructor(readonly id: string) {
    super(`餐槽 id 必须是 'YYYY-MM-DD:lunch|dinner'：${id}`);
    this.name = 'InvalidSlotIdError';
  }
}

/**
 * 定餐 = 改餐（总纲 §2.1：同一个编辑器）：把整份菜单一次性落成一条事件。
 * 未定 → 第一条是「预定」；已定 → 后续每条都是「改餐」。事件只追加，不改写历史。
 *
 * 内容与当前状态完全相同时不追事件：ADR-0007 留痕的是「菜单的变化」，
 * 手机双击保存不该在历史里多出两条一模一样的记录。
 */
export function bookSlot(db: Db, clock: Clock, id: string, booking: SlotBooking): MealSlot {
  const parsed = parseSlotId(id);
  if (!parsed) throw new InvalidSlotIdError(id);
  if (hasMealPassed(clock, parsed.date, parsed.meal)) throw new SlotPassedError(id);

  const diners = resolveDiners(db, booking.diners);
  const dishes = resolveDishes(db, booking.dishes);
  const source: BookingSource = booking.source ?? 'manual';

  const append = db.transaction((): void => {
    const now = listSlotEvents(db, id);
    const current = now[now.length - 1];
    if (current && current.type !== 'cancel' && sameMenu(current, diners, dishes) && current.source === source) return;
    insertEvent(db, clock, {
      id,
      date: parsed.date,
      meal: parsed.meal,
      // 本票（手动定餐）只会产生 replace；replace_set（换一整套）由 #18 写入——
      // 类型先在那里备好，否则 #18 改 CHECK 就要重建事件表（append-only 的表不好碰）
      type: current && current.type !== 'cancel' ? 'replace' : 'decide',
      source,
      diners,
      dishes,
    });
  });
  append();
  return foldSlot(db, clock, parsed.date, parsed.meal);
}

/** 取消：已定 → 未定（历史留痕）。已经未定的餐槽没有可取消的东西，报 404。 */
export function cancelSlot(db: Db, clock: Clock, id: string): void {
  const parsed = parseSlotId(id);
  if (!parsed) throw new InvalidSlotIdError(id);

  const append = db.transaction((): void => {
    const history = listSlotEvents(db, id);
    const current = history[history.length - 1];
    if (!current || current.type === 'cancel') throw new SlotNotDecidedError(id);
    insertEvent(db, clock, {
      id,
      date: parsed.date,
      meal: parsed.meal,
      type: 'cancel',
      source: 'manual',
      diners: [],
      dishes: [],
    });
  });
  append();
}

interface NewEvent {
  id: string;
  date: string;
  meal: MealKind;
  type: MealEventType;
  source: BookingSource;
  diners: DinerRef[];
  dishes: MenuDish[];
}

function insertEvent(db: Db, clock: Clock, event: NewEvent): void {
  const result = db
    .prepare(
      `INSERT INTO meal_events (slot_id, slot_date, meal, type, source, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(event.id, event.date, event.meal, event.type, event.source, clock.now().toISOString());
  const seq = Number(result.lastInsertRowid);

  const insertDiner = db.prepare(
    'INSERT INTO meal_event_diners (seq, position, member_id, member_name, member_emoji) VALUES (?, ?, ?, ?, ?)',
  );
  event.diners.forEach((diner, position) => insertDiner.run(seq, position, diner.memberId, diner.name, diner.emoji));

  const insertDish = db.prepare(
    'INSERT INTO meal_event_dishes (seq, position, recipe_id, keep_leftover) VALUES (?, ?, ?, ?)',
  );
  event.dishes.forEach((dish, position) => insertDish.run(seq, position, dish.recipeId, dish.keepLeftover ? 1 : 0));
}

/**
 * 用餐者名单快照：按请求给的顺序存当时**姓名与头像**（家人后来改名/删号也不改写历史）。
 * 空名单拒收——忌口、家规、份量全以它为基数，空名单没有意义（宁可报错也别折出 0 份量的餐）。
 */
function resolveDiners(db: Db, memberIds: string[]): DinerRef[] {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) throw new EmptyDinersError();
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, name, emoji FROM members WHERE id IN (${placeholders})`)
    .all(...unique) as { id: string; name: string; emoji: string }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique.map((memberId) => {
    const row = byId.get(memberId);
    if (!row) throw new UnknownMemberError(memberId);
    return { memberId: row.id, name: row.name, emoji: row.emoji };
  });
}

/**
 * 菜品：按请求顺序，记住菜名与荤素位（事件子表只存 recipe_id，名字现读菜谱表）。
 *
 * 只拒退役：草稿可以是**外部菜谱池**的补位菜（spec S6：某荤素位候选 <3 时外部菜谱上桌、
 * 之后转正），拒掉它就等于把外部补位这条路提前堵死（#17 的活）。退役则是「家里不再做」，
 * 不该重新出现在菜单上——要吃就重新转正。
 */
function resolveDishes(db: Db, inputs: SlotBooking['dishes']): MenuDish[] {
  if (inputs.length === 0) throw new EmptyDishesError();
  const seen = new Set<string>();
  return inputs.map((input) => {
    if (seen.has(input.recipeId)) throw new DuplicateDishError(input.recipeId);
    seen.add(input.recipeId);
    const recipe = findRecipe(db, input.recipeId);
    if (!recipe) throw new UnknownRecipeError(input.recipeId);
    if (recipe.status === 'retired') throw new RecipeRetiredError(input.recipeId);
    return {
      recipeId: recipe.id,
      name: recipe.name,
      kind: recipe.kind,
      keepLeftover: input.keepLeftover ?? false,
    };
  });
}

function sameMenu(event: MealEvent, diners: DinerRef[], dishes: MenuDish[]): boolean {
  if (event.diners.length !== diners.length || event.dishes.length !== dishes.length) return false;
  const sameDiners = event.diners.every((diner, index) => diner.memberId === diners[index]!.memberId);
  const sameDishes = event.dishes.every(
    (dish, index) =>
      dish.recipeId === dishes[index]!.recipeId && dish.keepLeftover === dishes[index]!.keepLeftover,
  );
  return sameDiners && sameDishes;
}

/** 用餐者名单为空 */
export class EmptyDinersError extends Error {
  constructor() {
    super('用餐者名单不能为空');
    this.name = 'EmptyDinersError';
  }
}

/** 一道菜都没有 */
export class EmptyDishesError extends Error {
  constructor() {
    super('菜单里至少要有一道菜');
    this.name = 'EmptyDishesError';
  }
}

/** 同一道菜在一次菜单里出现两次 */
export class DuplicateDishError extends Error {
  constructor(readonly recipeId: string) {
    super(`同一道菜不能重复：${recipeId}`);
    this.name = 'DuplicateDishError';
  }
}

/** 菜品指向不存在的菜谱 */
export class UnknownRecipeError extends Error {
  constructor(readonly recipeId: string) {
    super(`菜谱库里没有这道菜：${recipeId}`);
    this.name = 'UnknownRecipeError';
  }
}

/** 菜品指向一道已退役的菜（退役 = 家里不再做，要吃先转正） */
export class RecipeRetiredError extends Error {
  constructor(readonly recipeId: string) {
    super(`这道菜已经退役了：${recipeId}`);
    this.name = 'RecipeRetiredError';
  }
}

/** 用餐者不是家人 */
export class UnknownMemberError extends Error {
  constructor(readonly memberId: string) {
    super(`家人列表里没有这个人：${memberId}`);
    this.name = 'UnknownMemberError';
  }
}

// ---------------------------------------------------------------- 历史查询

interface RecentRow {
  recipe_id: string;
  name: string;
  kind: RecipeKind;
  slot_id: string;
  slot_date: string;
  meal: MealKind;
}

/**
 * 「最近吃过」（总纲 §3 决议 3：直接查事件流，不另建汇总表）。
 *
 * 口径：窗口 = 最近 `days` 个家庭日历日（含今天）；只算**已经上桌**的餐（过了截止时刻），
 * 明天才做的不算吃过；每餐槽只认**当前有效**的那条事件——被改餐改掉的旧版本与取消（没做）
 * 都不算。同菜按菜谱去重，给出窗口内最近一次那一餐与出现次数（推荐期的软避让要知道「多久没吃了」）。
 */
export function recentDishes(db: Db, clock: Clock, days: number): RecentDish[] {
  const today = todayOf(clock);
  const from = addDays(today, -(days - 1));
  const rows = db
    .prepare(
      `SELECT d.recipe_id, r.name, r.kind, e.slot_id, e.slot_date, e.meal
         FROM meal_events e
         JOIN meal_event_dishes d ON d.seq = e.seq
         JOIN recipes r ON r.id = d.recipe_id
        WHERE e.slot_date BETWEEN ? AND ?
          -- 每餐槽的最后一条事件才代表当前状态（否则改餐前的旧版本会被当成吃过）
          AND e.seq = (SELECT MAX(e2.seq) FROM meal_events e2 WHERE e2.slot_id = e.slot_id)
        ORDER BY e.slot_date DESC, e.meal DESC, d.position`,
    )
    .all(from, today) as RecentRow[];

  const byRecipe = new Map<string, RecentDish>();
  for (const row of rows) {
    if (!hasMealPassed(clock, row.slot_date, row.meal)) continue;
    const existing = byRecipe.get(row.recipe_id);
    if (existing) {
      existing.times += 1;
      continue;
    }
    byRecipe.set(row.recipe_id, {
      recipeId: row.recipe_id,
      name: row.name,
      kind: row.kind,
      slotId: row.slot_id,
      date: row.slot_date,
      meal: row.meal,
      times: 1,
    });
  }
  // 最近吃过的排前面（同一天午晚都有时，晚餐更近）
  return [...byRecipe.values()].sort((a, b) =>
    a.date === b.date ? b.meal.localeCompare(a.meal) : a.date < b.date ? 1 : -1,
  );
}
