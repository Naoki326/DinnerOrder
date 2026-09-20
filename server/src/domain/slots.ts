import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type {
  BookingSource,
  DinerRef,
  LeftoverSource,
  LlmCallMeta,
  MealEvent,
  MealEventType,
  MealKind,
  MealSlot,
  Menu,
  MenuDish,
  RecipeKind,
  RecentDish,
  SlotBooking,
} from '../wire-types.js';
import { findRecipe } from './recipes.js';
import { ACTIVE_MEMBERS_PREDICATE } from './members.js';
import { addDays, familyDate, familyInstant, parseDate } from './family-time.js';
import { familyRules } from './family-rules.js';
import { promptVersionFor } from '../llm/prompt.js';

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
  leftover_menu_slot_id: string | null;
  // 掌勺者快照（011）：三列同生共死（迁移里的跨列 CHECK 钉死）
  cook_member_id: string | null;
  cook_member_name: string | null;
  cook_member_emoji: string | null;
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

/**
 * 这一餐是否已经过了截止时刻（过了就当它已经上桌：不再可定、不再可改、进「最近吃过」窗口）。
 *
 * 截止时刻是**家规**（#20 从 `family-time.ts` 的常量搬进 `family_rules` 表，默认午 14:00 / 晚 21:00）：
 * 读表而不是读常量，「全部可调」才是真的。
 */
export function hasMealPassed(db: Db, clock: Clock, date: string, meal: MealKind): boolean {
  const now = clock.now();
  if (date < familyDate(now)) return true;
  if (date > familyDate(now)) return false;
  const rules = familyRules(db);
  const hour = meal === 'lunch' ? rules.lunchCutoffHour : rules.dinnerCutoffHour;
  return now.getTime() >= familyInstant(date, hour).getTime();
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
  return toSlot(db, clock, date, meal, history);
}

function toSlot(db: Db, clock: Clock, date: string, meal: MealKind, history: MealEvent[]): MealSlot {
  const last = history[history.length - 1];
  // 「吃剩的」那一餐没有自己的菜品快照（吃的就是被引用那一餐多做的那几道）：
  // 菜单从被引用那一餐**现推导**，于是中午改了菜、晚餐跟着变，两边不会各说各的。
  const declaresLeftover = last !== undefined && last.type !== 'cancel' && last.leftoverSlotId !== null;
  const leftover = declaresLeftover ? leftoverSourceOf(db, date, meal) : null;
  // 引用指不着东西的那一餐**当未定读**（而不是「已定但零道菜」）：一份菜单至少要有一道菜，
  // 「已定 + 空菜单」是个自相矛盾的状态，下一站就是读接口报错。正常路径上走不到这里
  // （取消联动会先把引用方退回未定），兜的是手改库/删库留下的悬空引用。
  const decided = last !== undefined && last.type !== 'cancel' && (last.leftoverSlotId === null || leftover !== null);
  return {
    id: slotId(date, meal),
    date,
    meal,
    status: decided ? 'decided' : 'undecided',
    menu: decided
      ? leftover === null
        ? { diners: last.diners, dishes: last.dishes, leftoverSlotId: null }
        : { diners: last.diners, dishes: leftover.dishes, leftoverSlotId: leftover.slotId }
      : null,
    // 掌勺者（011，本票）：与菜单同一条折叠——未定/取消 = 没指定（null）。
    // 已定时取**最后一条事件**的快照（家人后来改名/被删也不改写历史）。
    cook: decided ? last.cook : null,
    // “不指定时保存会写成谁”（本票）：按上一餐继承。未定餐槽的界面拿它显示缺省，
    // 不自己拼一遍（“上一餐”是服务端的事件流知识，前端不一定看得见）。
    cookDefault: inheritedCook(db, date, meal),
    editable: !hasMealPassed(db, clock, date, meal),
    canUndoSet: canUndoSet(history),
    leftoverSource: leftoverSourceOf(db, date, meal),
  };
}

/**
 * 现在能不能「撤销换一整套」（#18：换一整套重新生成且可反悔回上一套）。
 *
 * 规则：最后一条事件必须是 `replace_set` + `source='recommendation'`——那正是「换一整套」
 * （接受一份整餐推荐）的留痕。撤销之后末事件变成 `replace_set` + `manual`（撤销本身也是一条留痕），
 * 于是 `canUndoSet` 自然变成 false：**不能连着撤销两次**（没有 ping-pong）。
 *
 * 为何用 `source` 而不是新造一个事件类型：`replace_set` 在 002 的 CHECK 里已备好、
 * ADR-0007 特意把「换单道」与「换一整套」分开记，接受整餐推荐与「换一整套」在语义上
 * 本来就是同一件事（整餐重新生成）；两者的区别是**这一套是怎么来的**，那正是 `source` 的含义。
 */
function canUndoSet(history: MealEvent[]): boolean {
  const last = history[history.length - 1];
  return last !== undefined && last.type === 'replace_set' && last.source === 'recommendation';
}

/** 某餐槽的全部留痕（按发生顺序）——「为什么推这道 / 为什么没推」的回溯入口 */
export function listSlotEvents(db: Db, id: string): MealEvent[] {
  const rows = db
    .prepare(
      `SELECT seq, slot_id, slot_date, meal, type, source, occurred_at,
              llm_model, llm_prompt_version, llm_latency_ms, llm_degraded, leftover_menu_slot_id,
              cook_member_id, cook_member_name, cook_member_emoji
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
    leftoverSlotId: row.leftover_menu_slot_id,
    cook: cookOf(row),
    llm: llmMeta(row),
  }));
}

/** 事件行上的掌勺者快照 → 线上形状；没指定（三列全空）为 null */
function cookOf(row: EventRow): DinerRef | null {
  if (row.cook_member_id === null) return null;
  return {
    memberId: row.cook_member_id,
    name: row.cook_member_name!,
    emoji: row.cook_member_emoji!,
  };
}

// ---------------------------------------------------------------- 「吃剩的」引用（#22）

/**
 * 一餐能被「吃剩的」引用的是**同日午餐**：晚餐吃中午剩的（总纲 §2.6）。
 * 午餐没有可引用的上一餐（早餐不进模型），所以只有晚餐有这个形态。
 */
export function leftoverSlotOf(date: string, meal: MealKind): string | null {
  return meal === 'dinner' ? slotId(date, 'lunch') : null;
}

/** 某餐槽当前有效的那条事件（最后一条，取消也算它就是当前状态）；没有事件返回 undefined */
function lastEventOf(db: Db, id: string): MealEvent | undefined {
  return listSlotEvents(db, id).at(-1);
}

/**
 * 某一餐「吃剩的」来源：同日午餐**当前可吃**的留量菜品。
 * 午餐还没定 / 已被取消 / 一道菜都没标留量 → null（没有可吃剩的）。
 */
function leftoverSourceOf(db: Db, date: string, meal: MealKind): LeftoverSource | null {
  const sourceId = leftoverSlotOf(date, meal);
  if (sourceId === null) return null;
  const source = lastEventOf(db, sourceId);
  if (!source || source.type === 'cancel') return null;
  const dishes = source.dishes.filter((dish) => dish.keepLeftover);
  if (dishes.length === 0) return null;
  return { slotId: sourceId, dishes };
}

/** 当前有效事件里还引用着 `id` 的餐槽（按槽 id 排序） */
function referencingSlots(
  db: Db,
  id: string,
): { slot_id: string; slot_date: string; meal: MealKind }[] {
  return db
    .prepare(
      `SELECT e.slot_id, e.slot_date, e.meal FROM meal_events e
        WHERE e.leftover_menu_slot_id = ?
          -- 只看每个餐槽的最后一条事件：改餐把引用改掉了就不算引用
          AND e.seq = (SELECT MAX(e2.seq) FROM meal_events e2 WHERE e2.slot_id = e.slot_id)
        ORDER BY e.slot_id`,
    )
    .all(id) as { slot_id: string; slot_date: string; meal: MealKind }[];
}

/** 这一餐当前事件里标了留量的菜（被引用方视角：有没有可吃剩的） */
function keptDishCount(db: Db, id: string): number {
  const last = lastEventOf(db, id);
  if (!last || last.type === 'cancel') return 0;
  return last.dishes.filter((dish) => dish.keepLeftover).length;
}

/**
 * 这一餐此刻有没有「生效中的留量引用」（总纲 §2.6 的「有效引用」）——份量引擎据此决定上浮。
 *
 * 两个方向都算生效：
 *   * 本餐是「吃剩的」引用方：它没有多买菜，但端的正是被引用那一餐多做的那几道，读数照上浮；
 *   * 本餐是被引用方（同日午餐）：多做的那几道正是给它留的。
 *
 * 取消联动之后引用方退回未定、被引用方退回未定，两边都自然不再生效——不需要另存状态位。
 */
export function leftoverReferenceActive(db: Db, id: string): boolean {
  const parsed = parseSlotId(id);
  // 不合法的 id 没有「有没有引用」可言：当「无引用」静默返回 false 会让调用方拿到一个
  // 看着正常、其实少乘了一个系数的读数。宁可明确报错（与餐槽路由同一种 400 形状）。
  if (!parsed) throw new InvalidSlotIdError(id);
  const mine = lastEventOf(db, id);
  if (!mine || mine.type === 'cancel') return false;
  if (mine.leftoverSlotId !== null) return leftoverSourceOf(db, parsed.date, parsed.meal) !== null;
  return referencingSlots(db, id).length > 0;
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
  const start = hasMealPassed(db, clock, today, 'dinner') ? addDays(today, 1) : today;
  const dates = Array.from({ length: days }, (_, offset) => addDays(start, offset));
  const history = eventsBySlot(db, dates[0]!, dates[dates.length - 1]!);
  const slots: MealSlot[] = [];
  for (const date of dates) {
    for (const meal of ['lunch', 'dinner'] as const) {
      const slot = toSlot(db, clock, date, meal, history.get(slotId(date, meal)) ?? []);
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
 * 回传的 LLM 元数据里 `promptVersion` 不是**这个来源**该用的模板版本（#17 审查欠账，#18 收紧）。
 *
 * 为什么领域层也要拦一道：`llm` 元数据是**客户端回传**的（推荐接口刻意不落库，总纲 §4），
 * 形状对不代表内容真：任何字符串都能写进 append-only 的留痕，而留痕的全部价值是能回溯到
 * 「当时用的是哪张模板」（ADR-0007）。所以版本号不但要在代码库里，还得**与产生它的那条路绑定**
 * （`source='recommendation'` 只接受整餐推荐模板；换菜候选模板不产生这种留痕）。
 */
export class UnknownPromptVersionError extends Error {
  constructor(readonly promptVersion: string) {
    super(`这不是代码库里已知的 prompt 模板版本：${promptVersion}`);
    this.name = 'UnknownPromptVersionError';
  }
}

/** 没有「换一整套」可撤销（末事件不是 replace_set + recommendation） */
export class NothingToUndoError extends Error {
  constructor(readonly id: string) {
    super(`这一餐没有可撤销的换套：${id}`);
    this.name = 'NothingToUndoError';
  }
}

/**
 * 定餐 = 改餐（总纲 §2.1：同一个编辑器）：把整份菜单一次性落成一条事件。
 * 未定 → 第一条是「预定」；已定 → 后续每条都是「改餐」。事件只追加，不改写历史。
 *
 * 「吃剩的」（#22、总纲 §2.6）：`booking.leftoverOf` 指名被引用那一餐时，本餐落成**引用形态**
 * ——不存自己的菜品快照（吃什么从被引用那一餐现推导），留量上浮记在被引用那一餐的留量菜上。
 *
 * 内容与当前状态完全相同时不追事件：ADR-0007 留痕的是「菜单的变化」，
 * 手机双击保存不该在历史里多出两条一模一样的记录。
 */
export function bookSlot(db: Db, clock: Clock, id: string, booking: SlotBooking): MealSlot {
  const parsed = parseSlotId(id);
  if (!parsed) throw new InvalidSlotIdError(id);
  if (hasMealPassed(db, clock, parsed.date, parsed.meal)) throw new SlotPassedError(id);

  const diners = resolveDiners(db, booking.diners);
  const leftoverOf = booking.leftoverOf ?? null;
  // 掌勺者（011）：不传 = 按**上一餐**继承（家里还没做过就按 is_cook）；显式 null = 这一餐不指定。
  const cook = resolveCook(db, parsed.date, parsed.meal, booking.cook);
  // 「吃剩的」形态与自带菜单互斥：两份菜单（本餐的快照 vs 被引用那一餐的菜）一旦并存，
  // 「这一餐到底吃什么」就有两个说得通、但会漂移的答案。宁可 400 也不存一个要自己解释的菜单。
  if (leftoverOf !== null && booking.dishes.length > 0) throw new LeftoverWithDishesError(id);
  const dishes = leftoverOf === null ? resolveDishes(db, booking.dishes) : [];
  if (leftoverOf !== null) assertLeftoverSource(db, parsed.date, parsed.meal, id, leftoverOf);

  const source: BookingSource = booking.source ?? 'manual';
  // 元数据只在「接受推荐」时合法：手动挑菜却声称「这是 LLM 推的」会在留痕里变成假证据，
  // 而留痕的全部价值就是可回溯——宁可 400 也别写一条解释不了的记录。
  if (booking.llm !== undefined && source !== 'recommendation') {
    throw new LlmMetaWithoutRecommendationError(id);
  }
  // 回传的版本号必须是**这个来源**该用的模板（ADR-0007：模板进代码库 git 管版本）
  if (booking.llm !== undefined && promptVersionFor(source) !== booking.llm.promptVersion) {
    throw new UnknownPromptVersionError(booking.llm.promptVersion);
  }

  const append = db.transaction((): void => {
    const now = listSlotEvents(db, id);
    const current = now[now.length - 1];
    const changed =
      !current ||
      current.type === 'cancel' ||
      !sameMenu(current, diners, dishes, leftoverOf) ||
      !sameCook(current.cook, cook) ||
      current.source !== source;
    if (changed) {
      insertEvent(db, clock, {
        id,
        date: parsed.date,
        meal: parsed.meal,
        type: eventTypeFor(current, source),
        source,
        diners,
        dishes,
        cook,
        leftoverOf,
        llm: booking.llm,
      });
    }
    // 改午餐把留量标记全拆了：引用它的晚餐就再没有可吃剩的菜了。留在「已定 + 零道菜」
    // 不是一份说得通的菜单（菜单至少要有一道菜），所以在这里就把它退回去（同一条事务）。
    // 引用还有效时晚餐照常跟着新菜单变（现推导的意义），不必动它。
    if (parsed.meal === 'lunch' && keptDishCount(db, id) === 0) releaseReferencingSlots(db, clock, id);
  });
  append();
  return foldSlot(db, clock, parsed.date, parsed.meal);
}

/**
 * 「吃剩的」引用必须指得着东西（总纲 §2.6 的「有效引用」）：
 *   * 只接受**同日午餐**（晚餐吃中午剩的）；
 *   * 那一餐得已定且当前有效（被取消过的不能再引用）；
 *   * 而且至少有一道标了留量的菜——没有留量就没有可吃剩的，那一餐的语义是空的。
 *
 * 取消联动的另一半在 `cancelSlot`：午餐被取消时会把引用它的晚餐退回未定，
 * 所以这里的检查只需面对「现在还没定过 / 已取消」这两种情况。
 */
function assertLeftoverSource(db: Db, date: string, meal: MealKind, id: string, referencedId: string): void {
  // 只有晚餐有「吃剩的」形态：`leftoverSlotOf` 对午餐返回 null，于是一律拒掉
  const expected = leftoverSlotOf(date, meal);
  if (expected === null || referencedId !== expected) {
    throw new InvalidLeftoverReferenceError(id, referencedId);
  }
  const referenced = parseSlotId(referencedId);
  const source = referenced === undefined ? undefined : lastEventOf(db, referencedId);
  if (!referenced || !source || source.type === 'cancel') throw new InvalidLeftoverReferenceError(id, referencedId);
  if (!source.dishes.some((dish) => dish.keepLeftover)) {
    throw new NothingToReheatError(id, referencedId);
  }
}

/**
 * 取消：已定 → 未定（历史留痕）。已经未定的餐槽没有可取消的东西，报 404。
 *
 * **联动**（总纲 §3 决议 4）：取消被「吃剩的」引用的那一餐时，引用方餐槽自动退回未定，
 * 并返回被退回的槽 id（界面据此提示「晚餐已经跟着取消了」）。退回走的是**再追加一条取消事件**
 * ——ADR-0007 没有可改的状态表，也不该有：联动本身也是一次「菜单的变化」，要留下痕迹。
 */
export function cancelSlot(db: Db, clock: Clock, id: string): string[] {
  const parsed = parseSlotId(id);
  if (!parsed) throw new InvalidSlotIdError(id);

  let released: string[] = [];
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
      // 取消 = 这一餐没有了，掌勺者也一并清掉（没有餐就没有「谁做」）
      cook: null,
      leftoverOf: null,
    });
    released = releaseReferencingSlots(db, clock, id);
  });
  append();
  return released;
}

/**
 * 把当前还引用着 `id` 的餐槽退回未定（一条 cancel 事件），返回被退回的槽 id。
 *
 * 两处触发（都是「被引用的那一餐没有可吃剩的了」）：
 *   * `cancelSlot`：本餐被取消（总纲 §3 决议 4 明写的联动）；
 *   * `bookSlot`：本餐被改得一道留量菜都没有了（引用失效；不是取消，但引用方同样不能再停
 *     在「已定 + 零道菜」上）。
 *
 * 「还引用着」按每个餐槽的**最后一条事件**判：引用早被改餐改掉的餐槽不会被这一下误伤。
 * 取消事件不带引用字段（取消就是没有这一餐，引用关系一并消失）。
 */
function releaseReferencingSlots(db: Db, clock: Clock, id: string): string[] {
  const rows = referencingSlots(db, id);
  for (const row of rows) {
    insertEvent(db, clock, {
      id: row.slot_id,
      date: row.slot_date,
      meal: row.meal,
      type: 'cancel',
      source: 'manual',
      diners: [],
      dishes: [],
      cook: null,
      leftoverOf: null,
    });
  }
  return rows.map((row) => row.slot_id);
}

/**
 * 撤销「换一整套」（#18：换一整套重新生成且可反悔回上一套）。
 *
 * 实现是**再追加一条事件**（append-only：历史不删）。恢复的内容就是「上一条事件」的
 * diners + dishes 快照——这正是事件流模型里「上一套」的准确含义：不是另存一份快照，
 * 而是问留痕「在这条之前这一餐长什么样」。
 *
 * 事件类型用 `replace_set` + `source='manual'`：语义是「又换了一整套，但这次是手工的（撤销）」；
 * 它顺带把 `canUndoSet` 从 true 变成 false——撤销只走一步，不能无限来回。
 */
export function undoSet(db: Db, clock: Clock, id: string): MealSlot {
  const parsed = parseSlotId(id);
  if (!parsed) throw new InvalidSlotIdError(id);

  const append = db.transaction((): void => {
    const history = listSlotEvents(db, id);
    const last = history[history.length - 1];
    if (!last || !canUndoSet(history)) throw new NothingToUndoError(id);

    // 「上一套」= 这条 replace_set 之前的那条事件（它可能也是 replace_set，也可能是 decide/replace）
    const previous = history[history.length - 2];
    if (!previous || previous.type === 'cancel') throw new NothingToUndoError(id);

    // 上一套是「吃剩的」时，它得**现在还指得着**才回得去：
    //   dinner 定成吃剩的 → 换成整套推荐（引用没了）→ 午餐被取消 → 这时撤销，
    //   previous 里那个引用已经指向一餐不存在的午餐了。回不去不是 bug：那一套的菜
    //   （多做的那几道）本来就不存在了，而「吃剩的」事件又不带菜品快照，恢复不出一份菜单。
    //   （读侧把悬空引用当未定读作为兼底，但那条路不该被写出来。）
    if (previous.leftoverSlotId !== null) {
      const source = leftoverSourceOf(db, parsed.date, parsed.meal);
      if (source === null || source.slotId !== previous.leftoverSlotId) throw new NothingToUndoError(id);
    }

    insertEvent(db, clock, {
      id,
      date: parsed.date,
      meal: parsed.meal,
      type: 'replace_set',
      source: 'manual',
      diners: previous.diners,
      dishes: previous.dishes,
      // 撤销退回的是上一条事件的**内容**：掌勺者也回到那一条的快照（本票），
      // 只退菜不退人就等于把「谁做这一套」留在了被撤掉的那一套上。
      cook: previous.cook,
      // 撤销退回的是上一条事件的**内容**，连同它的「吃剩的」引用一起：
      // 只退菜不退引用，会让一份「吃剩的」菜单失去它的由来（留痕就断了）。
      leftoverOf: previous.leftoverSlotId,
    });
  });
  append();
  return foldSlot(db, clock, parsed.date, parsed.meal);
}

interface NewEvent {
  id: string;
  date: string;
  meal: MealKind;
  type: MealEventType;
  source: BookingSource;
  diners: DinerRef[];
  dishes: MenuDish[];
  /** 这一餐的掌勺者快照（011）；取消/未指定为 null */
  cook: DinerRef | null;
  /** 「吃剩的」引用（#22）：普通定餐（含改餐/撤销/取消）为空 */
  leftoverOf: string | null;
  /** 接受推荐时带的 LLM 元数据（手动定餐为 undefined） */
  llm?: LlmCallMeta;
}

/**
 * 该记哪种事件（ADR-0007 的词汇）：
 *   * 未定 → 第一条是「预定」（decide）；
 *   * 已定 → 换一整套（replace_set）——**接受整餐推荐就是把这一餐整套换掉**，
 *     ADR-0007 特意把「换单道」与「换一整套」分开记，因为后者要能反悔回上一套（#18）。
 *     在同一个编辑器里手动换掉几道菜仍然是「改餐」（replace），两者靠 source 区分。
 */
function eventTypeFor(current: MealEvent | undefined, source: BookingSource): MealEventType {
  const decided = current !== undefined && current.type !== 'cancel';
  if (!decided) return 'decide';
  return source === 'recommendation' ? 'replace_set' : 'replace';
}

function insertEvent(db: Db, clock: Clock, event: NewEvent): void {
  const result = db
    .prepare(
      `INSERT INTO meal_events
         (slot_id, slot_date, meal, type, source, occurred_at,
          llm_model, llm_prompt_version, llm_latency_ms, llm_degraded, leftover_menu_slot_id,
          cook_member_id, cook_member_name, cook_member_emoji)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.date,
      event.meal,
      event.type,
      event.source,
      clock.now().toISOString(),
      // 三件套要么都空、要么都齐（002 的 CHECK）：只接受完整的元数据，半份会在库里被拒
      event.llm?.model ?? null,
      event.llm?.promptVersion ?? null,
      event.llm?.latencyMs ?? null,
      event.llm === undefined ? null : event.llm.degraded ? 1 : 0,
      event.leftoverOf,
      // 掌勺者快照（011）：三列同生共死，库里的跨列 CHECK 是最后一道（同 diners 的快照口径）
      event.cook?.memberId ?? null,
      event.cook?.name ?? null,
      event.cook?.emoji ?? null,
    );
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
 * 这一餐的掌勺者（011，按餐指定）。三种输入对应三种语义：
 *   * `undefined`（**不传**）= 按**上一餐继承**：取最近一次“已经定下来的掌勺者”（含本餐槽自己的
 *     上一条事件）；一路往前没有就回落到家里通常做菜的那位（`is_cook`），再没有就是 null。
 *     定餐界面三套视图都不必自己拼这个缺省，服务端一处说了算。
 *   * `null` = 这一餐明确不指定掌勺者。
 *   * 家人 id = 就这个人；已删/不存在报 `UnknownCookError`（与 `resolveDiners` 同一口径：
 *     新写的菜单里不该出现已删的家人，历史里的快照另走读路径）。
 *
 * 存**快照**（本票）：把当时的姓名/头像一起写进事件（与 `meal_event_diners` 同一做法），
 * 家人后来改名/删号也不改写历史——不留一个会显示 undefined 的洞。
 */
function resolveCook(db: Db, date: string, meal: MealKind, memberId: string | null | undefined): DinerRef | null {
  if (memberId === undefined) return inheritedCook(db, date, meal);
  if (memberId === null) return null;
  const row = db
    .prepare(`SELECT id, name, emoji FROM members WHERE id = ? AND ${ACTIVE_MEMBERS_PREDICATE}`)
    .get(memberId) as { id: string; name: string; emoji: string } | undefined;
  if (!row) throw new UnknownCookError(memberId);
  return { memberId: row.id, name: row.name, emoji: row.emoji };
}

/**
 * 不指定掌勺者时的缺省：**按上一餐继承**。
 *
 * 取“本餐槽自己或它之前最近的一餐里，当前生效的那位掌勺者”（只看每个餐槽的**最后一条事件**，
 * 所以取消/被改掉的旧掌勺者不算）。一路往前都没有（新库、从来没指定过）就回落到
 * `defaultCook`（家里通常做菜的那位，`is_cook`）——两个缺省叠起来的语义是“跟上一餐走；
 * 家里还没做过就按家里的习惯”。
 *
 * 为什么包含**本餐槽自己**（`<=`）：同一个餐槽再提交一次而不带 cook 时，应该是“保留原来那位”
 * 而不是“跳回到再前一餐”。
 *
 * 餐次顺序必须显式排（`lunch` < `dinner`）：`meal` 是文本列，字符串序里 'dinner' < 'lunch'，
 * 会把同日的晚餐当成午餐的“上一餐”。
 *
 * ⚠️ JOIN `members` 且限**在用**（`deleted_at IS NULL`）:被软删除的上一餐掌勺者不能继承给新餐。
 * 只靠事件里的快照不够——那快照是为了**读历史**存在的，而这里要**写一条新事件**，
 * 新写的餐里不该出现已删的家人（与 `resolveDiners` 同一口径）。所以上一餐那位被删了就继续
 * 往前找；都没有才回落 `defaultCook`。名字/头像用 `members` 的**当前值**（新事件记的是当下的谁）。
 */
function inheritedCook(db: Db, date: string, meal: MealKind): DinerRef | null {
  const mealRank = meal === 'lunch' ? 0 : 1;
  const row = db
    .prepare(
      `SELECT m.id, m.name, m.emoji
         FROM meal_events e
         JOIN members m ON m.id = e.cook_member_id AND m.${ACTIVE_MEMBERS_PREDICATE}
        WHERE cook_member_id IS NOT NULL
          -- 只看每个餐槽的最后一条事件：取消/改掉的旧掌勺者不算“上一餐做了的人”
          AND seq = (SELECT MAX(e2.seq) FROM meal_events e2 WHERE e2.slot_id = e.slot_id)
          -- 本餐槽自己也算（再提交一次 = 保留原来那位），但不看未来的餐
          AND (slot_date < ?
               OR (slot_date = ? AND (CASE meal WHEN 'lunch' THEN 0 ELSE 1 END) <= ?))
        ORDER BY slot_date DESC, (CASE meal WHEN 'lunch' THEN 0 ELSE 1 END) DESC
        LIMIT 1`,
    )
    .get(date, date, mealRank) as { id: string; name: string; emoji: string } | undefined;
  if (row === undefined) return defaultCook(db);
  return { memberId: row.id, name: row.name, emoji: row.emoji };
}

/**
 * 家里通常做菜的掌勺者：`is_cook` 的那位（多位时按 `sort_order` 取第一位），
 * 家里没人标就是 null。这是“按上一餐继承”之后的最底一层缺省。
 */
function defaultCook(db: Db): DinerRef | null {
  const row = db
    .prepare(
      `SELECT id, name, emoji FROM members
        WHERE is_cook = 1 AND ${ACTIVE_MEMBERS_PREDICATE}
        ORDER BY sort_order LIMIT 1`,
    )
    .get() as { id: string; name: string; emoji: string } | undefined;
  return row ? { memberId: row.id, name: row.name, emoji: row.emoji } : null;
}

/** 两份掌勺者快照是不是同一个人（按 memberId 判：名字改了不该被当成一次菜单变化） */
function sameCook(a: DinerRef | null, b: DinerRef | null): boolean {
  return (a?.memberId ?? null) === (b?.memberId ?? null);
}
function resolveDiners(db: Db, memberIds: string[]): DinerRef[] {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) throw new EmptyDinersError();
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, name, emoji FROM members WHERE id IN (${placeholders}) AND ${ACTIVE_MEMBERS_PREDICATE}`)
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
 *
 * `allowRetired` 给**份量引擎**用（#16）：历史菜单里可能有退役前的菜，份量算不出来
 * 就等于把那一餐的读数一起废掉；定餐入口不传（保持「退役不进菜单」）。
 */
export function resolveDishes(
  db: Db,
  inputs: SlotBooking['dishes'],
  options: { allowRetired?: boolean } = {},
): MenuDish[] {
  if (inputs.length === 0) throw new EmptyDishesError();
  const seen = new Set<string>();
  return inputs.map((input) => {
    if (seen.has(input.recipeId)) throw new DuplicateDishError(input.recipeId);
    seen.add(input.recipeId);
    const recipe = findRecipe(db, input.recipeId);
    if (!recipe) throw new UnknownRecipeError(input.recipeId);
    if (recipe.status === 'retired' && !options.allowRetired) throw new RecipeRetiredError(input.recipeId);
    return {
      recipeId: recipe.id,
      name: recipe.name,
      kind: recipe.kind,
      keepLeftover: input.keepLeftover ?? false,
    };
  });
}

function sameMenu(event: MealEvent, diners: DinerRef[], dishes: MenuDish[], leftoverOf: string | null): boolean {
  // 引用形态变了就是菜单变了（同一份菜但引用关系不同 = 不同的餐）：
  // 否则「吃剩的」与同菜单的普通定餐会互相短跑，留痕里看不出这一餐是怎么来的。
  if (event.leftoverSlotId !== leftoverOf) return false;
  if (event.diners.length !== diners.length || event.dishes.length !== dishes.length) return false;
  const sameDiners = event.diners.every((diner, index) => diner.memberId === diners[index]!.memberId);
  const sameDishes = event.dishes.every(
    (dish, index) =>
      dish.recipeId === dishes[index]!.recipeId && dish.keepLeftover === dishes[index]!.keepLeftover,
  );
  return sameDiners && sameDishes;
}

/**
 * 两份菜单在**买菜清单关心的意义上**是不是同一份：用餐者、菜品与留量标记、吃剩的引用。
 *
 * 刻意**不比掌勺者**（本票）：改「谁做这一餐」不改要买的食材与克数，不该把进行中的清单
 * 标成「菜单变了」——那是 #23 特意避免的假警告（读接口注释：“只对菜单真的变了的提交标过期”）。
 * 用餐者却**要**比：折算系数按用餐者算，换了人就换了克数，清单必须重算。
 * 路由层用它把「只改了掌勺者」的提交从 `menu_changed` 里排除。
 */
export function sameMenuContent(a: Menu | null, b: Menu | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.leftoverSlotId !== b.leftoverSlotId) return false;
  if (a.diners.length !== b.diners.length || a.dishes.length !== b.dishes.length) return false;
  const sameDiners = a.diners.every((diner, index) => diner.memberId === b.diners[index]!.memberId);
  const sameDishes = a.dishes.every(
    (dish, index) =>
      dish.recipeId === b.dishes[index]!.recipeId && dish.keepLeftover === b.dishes[index]!.keepLeftover,
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

/** 手动定餐却带上了 LLM 元数据（留痕里不能有解释不了的东西） */
export class LlmMetaWithoutRecommendationError extends Error {
  constructor(readonly id: string) {
    super(`只有 source='recommendation' 的定餐能携带 LLM 元数据：${id}`);
    this.name = 'LlmMetaWithoutRecommendationError';
  }
}

/** 「吃剩的」引用指的不是同日午餐（午餐没有可引用的上一餐；跨日引用没有语义） */
export class InvalidLeftoverReferenceError extends Error {
  constructor(
    readonly id: string,
    readonly referencedId: string,
  ) {
    super(`「吃剩的」只能引用同一日的午餐：${id} → ${referencedId}`);
    this.name = 'InvalidLeftoverReferenceError';
  }
}

/** 被引用的那一餐没有一道标了留量的菜（没有可吃剩的，「吃剩的」这句话是空的） */
export class NothingToReheatError extends Error {
  constructor(
    readonly id: string,
    readonly referencedId: string,
  ) {
    super(`被引用的那一餐没有标记留量的菜：${referencedId}`);
    this.name = 'NothingToReheatError';
  }
}

/** 「吃剩的」形态不接受自带菜单（吃什么从被引用那一餐推导，两个来源会打架） */
export class LeftoverWithDishesError extends Error {
  constructor(readonly id: string) {
    super(`「吃剩的」那一餐不接受自带菜单（吃的是被引用那一餐多做的那几道）：${id}`);
    this.name = 'LeftoverWithDishesError';
  }
}

/** 用餐者不是家人 */
export class UnknownMemberError extends Error {
  constructor(readonly memberId: string) {
    super(`家人列表里没有这个人：${memberId}`);
    this.name = 'UnknownMemberError';
  }
}

/** 送来的掌勺者不是（在用的）家人——与用餐者同一道校验 */
export class UnknownCookError extends Error {
  constructor(readonly memberId: string) {
    super(`掌勺者不是家人列表里的人：${memberId}`);
    this.name = 'UnknownCookError';
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
    if (!hasMealPassed(db, clock, row.slot_date, row.meal)) continue;
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
