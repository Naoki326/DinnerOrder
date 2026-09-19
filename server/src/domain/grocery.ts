import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type {
  FamilyRules,
  GroceryItem,
  GroceryItemSource,
  GroceryList,
  GroceryStaleReason,
  MealKind,
} from '../wire-types.js';
import { exchangeTable, portionOf } from './portion.js';
import { foldSlot, parseSlotId, todayOf } from './slots.js';

/**
 * 买菜清单（总纲 §2.7、§3；spec S8）——**物化实体**。
 *
 * 四条口径全在这里：
 *
 * 1. **聚合自己不算份量**。每道菜逐食材的本餐克数由份量引擎（`portionOf`）给出，清单只做
 *    「同名食材跨餐累加 + 记下来源」。自己再乘一遍系数就是第二套算术，迟早与菜单上显示的
 *    读数对不上（总纲 §3 决议 2：份量纯规则查表、只有一处）。
 * 2. **留量上浮天然计入**：#22 已把「留量标记 ∧ 有效引用」接进份量引擎（`DishPortion.uplift`
 *    报的是**实际生效**的系数），清单按份量引擎的读数累加，不需要（也不该有）第二条上浮逻辑。
 *    测试 `api/grocery.test.ts` 用「有引用 vs 无引用」的克数差证明它真的计入。
 * 3. **只买还没上桌的餐**。已过截止时刻的餐是吃过的，不是要买的（`editable` 由服务端按
 *    注入时钟判定）。「吃剩的」那一餐**不加采购**（原型 v1 口径）：它吃的是被引用那一餐
 *    多做的那几道，份量已经记在被引用那一餐上了，再算一遍就是双份。
 * 4. **过期只标不动行**（总纲 §2.7：改餐 → 标记过期 → 手动重算）。重算时「勾选按食材继承、
 *    手工行保留」——所以过期期间的行必须原样留着，它们正是重算要继承的东西。
 * 5. **过期原因存结构、不存中文**（#23 评审修复 ②）：`stale_reason` 是枚举（+ `stale_slot_id`
 *    说哪一餐），界面那句「⚠️ （今天午餐的菜单变了），清单过期了」由前端现拼——存渲染好的
 *    中文，改文案就是改历史数据，而「今天午餐」这种相对叫法还会随时间漂移。
 *    也因此本文件**没有**「今天/明天 + 午/晚餐」的文案逻辑：那套叫法只有显示层一处
 *    （`web/src/routes/GroceryView.tsx` 的 `mealLabel`，来源行与过期警告共用），服务端只给结构
 *    （来源的 date/meal、`stale_slot_id`）与 `/api/grocery` 的家庭时区 `today`。
 *
 * 分类分组不造新表：食材 → 分类的唯一现成依据是互换表已经挂好的 `ingredient_id` 指针
 * （WS/T 554 附录 A 的七组：肉禽 / 水产 / 蔬菜 / 主食 / 豆制品 / 奶 / 水果）。
 * 互换表里没挂指针的（菜心、鸡蛋、各种调料…）一律落「其他」——宁可粗一点，
 * 也不为分组再建一套分类（那正是「两套分类打架」的老路；台账明写别造新表）。
 */

/** 互换表组 id → 界面上的分组名（总纲 §2.7 的「分类分组」，粒度照原型 v1 的 CATS） */
const GROUP_LABELS: Record<string, string> = {
  meat: '肉禽',
  fish: '水产',
  vegetable: '蔬菜',
  staple: '主食',
  soy: '豆制品',
  dairy: '奶',
  fruit: '水果',
};

/** 其他：互换表里查不到指针的食材（调料、干货、市品口径差异的条目…） */
const OTHER_LABEL = '其他';

/**
 * 分组展示顺序：按掌勺者逛菜场的动线（荤、水产、蔬菜、主食、蛋豆、奶、水果），调料垫底。
 * 顺序表与标签表分开：标签是给人看的，顺序是排列纪律——改标签名不该动排列。
 */
const GROUP_ORDER = ['meat', 'fish', 'vegetable', 'staple', 'soy', 'dairy', 'fruit'];

const GROUP_RANK = new Map(GROUP_ORDER.map((group, index) => [GROUP_LABELS[group]!, index]));

/** 待入库的一条聚合行 */
interface AggregateRow {
  ingredientId: string;
  name: string;
  grams: number;
  needsRelabel: boolean;
  category: string;
  sources: GroceryItemSource[];
}

interface AggregateResult {
  rows: AggregateRow[];
  /** 这份清单聚合了几餐（「吃剩的」那一餐不计入：它不加采购） */
  mealCount: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function groupRank(label: string): number {
  return GROUP_RANK.get(label) ?? GROUP_ORDER.length;
}

/**
 * 食材 → 分组名：读互换表的 `ingredient_id` 指针（同一食材挂多条时取**第一条**，与表的读法一致）。
 * 返回值就是界面上的分组标签，前端不再做一次映射（分类只有这一处口径）。
 */
function categoryByIngredient(db: Db): Map<string, string> {
  const categories = new Map<string, string>();
  for (const group of exchangeTable(db)) {
    const label = GROUP_LABELS[group.id] ?? OTHER_LABEL;
    for (const item of group.items) {
      if (item.ingredientId !== null && !categories.has(item.ingredientId)) {
        categories.set(item.ingredientId, label);
      }
    }
  }
  return categories;
}

/**
 * 现在该买的餐槽（未上桌的**已定**餐，且不是「吃剩的」）。
 *
 * 不复用 `listUpcomingSlots`：那个函数是主界面「下一餐优先」的窗口（今天起 n 天），
 * 而清单的窗口不该由一个随便定的天数决定——「订到哪天就买到哪天」是这里唯一说得通的口径。
 * 所以：从今天往后扫事件流，逐餐折叠出当前状态，再按「已定 ∧ 还没过截止时刻 ∧ 不是吃剩的」筛。
 * 餐槽数是十几的量级，逐餐折叠的开销可以忽略；而且它天然排除了**历史餐**
 * （今天的日期在 `slot_date` 上，昨天的餐不进来）。
 */
function buyableSlots(db: Db, clock: Clock): { slotId: string; date: string; meal: MealKind }[] {
  const today = todayOf(clock);
  const rows = db
    .prepare(
      // 午在晚前显式排序：`meal` 是文本列，按默认字符串序会是 dinner < lunch（一天的顺序反了），
      // 而清单上的来源是照「今天午餐 → 今天晚餐」的动线读的。
      `SELECT DISTINCT slot_id, slot_date, meal FROM meal_events WHERE slot_date >= ?
        ORDER BY slot_date, CASE meal WHEN 'lunch' THEN 0 ELSE 1 END`,
    )
    .all(today) as { slot_id: string; slot_date: string; meal: MealKind }[];
  const buyable: { slotId: string; date: string; meal: MealKind }[] = [];
  for (const row of rows) {
    const slot = foldSlot(db, clock, row.slot_date, row.meal);
    if (slot.status !== 'decided' || !slot.editable || slot.menu === null) continue;
    // 「吃剩的」不加采购：它的菜是被引用那一餐多做的那几道，份量已经算在那边了
    if (slot.menu.leftoverSlotId !== null) continue;
    buyable.push({ slotId: row.slot_id, date: row.slot_date, meal: row.meal });
  }
  return buyable;
}

/**
 * 聚合：跨已定餐槽把同一食材的生重合计起来，并把「来自哪几餐的哪道菜」记在每一行上。
 * 份量一律问份量引擎（`portionOf`），这里只做加法与分组。
 */
function aggregateGrocery(db: Db, clock: Clock): AggregateResult {
  const categories = categoryByIngredient(db);
  const byIngredient = new Map<string, AggregateRow>();
  const slots = buyableSlots(db, clock);

  for (const slot of slots) {
    const menu = foldSlot(db, clock, slot.date, slot.meal).menu;
    if (menu === null) continue;
    // 带 slotId 算份量：留量上浮要问「这一餐有没有生效中的『吃剩的』引用」（#22）
    const portion = portionOf(
      db,
      clock,
      { diners: menu.diners.map((diner) => diner.memberId), dishes: menu.dishes },
      { missingMembers: 'assumeAdult', slotId: slot.slotId },
    );
    for (const dish of portion.dishes) {
      for (const ingredient of dish.ingredients) {
        const existing = byIngredient.get(ingredient.ingredientId);
        const row =
          existing ??
          {
            ingredientId: ingredient.ingredientId,
            name: ingredient.name,
            grams: 0,
            needsRelabel: false,
            category: categories.get(ingredient.ingredientId) ?? OTHER_LABEL,
            sources: [],
          };
        row.grams += ingredient.grams;
        // 0 克 = 「这个食材在菜里，但克数还没定」（导入期的模糊份量，迁移 005）：
        // 列出并标记，不静默跳过（台账「归属 #19」点名 #23 要有态度）
        if (ingredient.adultGrams <= 0) row.needsRelabel = true;
        row.sources.push({
          slotId: slot.slotId,
          date: slot.date,
          meal: slot.meal,
          recipeId: dish.recipeId,
          recipeName: dish.name,
        });
        if (!existing) byIngredient.set(ingredient.ingredientId, row);
      }
    }
  }

  const rows = [...byIngredient.values()].sort(
    (a, b) => groupRank(a.category) - groupRank(b.category) || b.grams - a.grams || a.name.localeCompare(b.name),
  );
  return { rows, mealCount: slots.length };
}

// ---------------------------------------------------------------- 物化

interface ListRow {
  id: number;
  status: 'active' | 'archived';
  stale: number;
  stale_reason: GroceryStaleReason | null;
  stale_slot_id: string | null;
  created_at: string;
  recalculated_at: string | null;
  archived_at: string | null;
  meal_count: number;
}

function activeListRow(db: Db): ListRow | undefined {
  return db.prepare("SELECT * FROM grocery_lists WHERE status = 'active'").get() as ListRow | undefined;
}

/**
 * 把聚合结果写成清单的行。勾选态按食材继承（`inherited`）：重算时同一食材的新行跟着旧行的勾选。
 * 行的 id 会变（老行删掉重建）——清单是「当前这份聚合」的物化，不是需要稳定身份的对象。
 */
function writeAggregateRows(db: Db, listId: number, rows: AggregateRow[], inherited: Map<string, boolean>): void {
  db.prepare("DELETE FROM grocery_items WHERE list_id = ? AND kind = 'aggregate'").run(listId);
  const insertItem = db.prepare(
    `INSERT INTO grocery_items (list_id, kind, ingredient_id, name, grams, checked, needs_relabel, position)
     VALUES (?, 'aggregate', ?, ?, ?, ?, ?, ?)`,
  );
  const insertSource = db.prepare(
    'INSERT INTO grocery_item_sources (item_id, position, slot_id, recipe_id) VALUES (?, ?, ?, ?)',
  );
  rows.forEach((row, position) => {
    const result = insertItem.run(
      listId,
      row.ingredientId,
      row.name,
      row.grams,
      inherited.get(row.ingredientId) === true ? 1 : 0,
      row.needsRelabel ? 1 : 0,
      position,
    );
    const itemId = Number(result.lastInsertRowid);
    row.sources.forEach((source, index) => insertSource.run(itemId, index, source.slotId, source.recipeId));
  });
}

/**
 * 取进行中的清单；没有就现物化一份（总纲 §2.7 的「物化实体」——第一次读就是第一次算）。
 *
 * 两条不走物化的路（两条都是读页面那条路，写路走 `activeListOrCreate`）：
 *
 * 1. **现在没有任何食材可买但也没有手工行**（没定过餐、或都吃过了）——空购物车没有信息量，
 *    凭空造一张空的只会让界面上一会儿有清单一会儿没有。
 * 2. **刚归档过、而当前菜单与归档那份一模一样**——这是「归档 → 刷新页面」这条再普通不过的路。
 *    物化一张内容相同的新清单等于把勾选洗掉，看起来就像归档没生效（用户会把“归档”理解成
 *    “重置”）。所以拿聚合的**指纹**与最近一份已归档清单比：一样就没有要买的新东西。
 */
export function groceryList(db: Db, clock: Clock): GroceryList | null {
  const existing = activeListRow(db);
  if (existing) return readGroceryList(db, existing.id);

  const aggregate = aggregateGrocery(db, clock);
  if (aggregate.rows.length === 0 || matchesArchived(db, aggregate)) return null;
  return materialize(db, clock, aggregate);
}

/**
 * 取进行中的清单；没有就建一张（**可以是空的**）——加手工行走这条。
 *
 * 与 `groceryList` 的差别就是那个“实在没东西可买就不建”的判断：掌勺者明确要往清单里放东西时，
 * 就算这会儿一餐都没定，也该有一张清单接着他写下去。
 */
export function activeListOrCreate(db: Db, clock: Clock): GroceryList {
  const existing = activeListRow(db);
  if (existing) return readGroceryList(db, existing.id);
  return materialize(db, clock, aggregateGrocery(db, clock));
}

/** 把聚合结果写成一张新的进行中清单（创建与「读时物化」共用这一处） */
function materialize(db: Db, clock: Clock, aggregate: AggregateResult): GroceryList {
  const now = clock.now().toISOString();
  const result = db
    .prepare(
      `INSERT INTO grocery_lists (status, stale, stale_reason, stale_slot_id, created_at, recalculated_at, archived_at, meal_count)
       VALUES ('active', 0, NULL, NULL, ?, ?, NULL, ?)`,
    )
    .run(now, now, aggregate.mealCount);
  const listId = Number(result.lastInsertRowid);
  writeAggregateRows(db, listId, aggregate.rows, new Map());
  return readGroceryList(db, listId);
}

/**
 * 当前聚合与**最近一份**已归档清单是不是同一份东西（食材、克数、来源逐项对）。
 *
 * 比指纹而不是比行数或时间：菜单改了又改回原样，这里就该说「没有要买的新东西」（正确）；
 * 比「归档时间 vs 定餐时间」会把这种情况误判成需要新清单。指纹从库里现读两边各一遍，
 * 不另存一列（存了就会与行内容漂移——它本来就是对行内容的函数）。
 */
function matchesArchived(db: Db, aggregate: AggregateResult): boolean {
  const latest = db
    .prepare("SELECT id FROM grocery_lists WHERE status = 'archived' ORDER BY archived_at DESC, id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  if (!latest) return false;
  return signatureOfItems(readGroceryList(db, latest.id).items) === signatureOfRows(aggregate.rows);
}

/**
 * 聚合的指纹：食材 + 克数 + 来源（来源逐对「哪一餐的哪道菜」）。
 * 两条路（现算的 `AggregateRow[]` vs 读库的 `GroceryItem[]`）用同一个字符串形状，
 * 靠一个恒等函数对上，而不是靠“两边碰巧一样”。
 */
function fingerprint(pairs: string[][]): string {
  return pairs
    .map((pair) => pair.join('/'))
    .sort()
    .join('|');
}

function signatureOfItems(items: GroceryItem[]): string {
  return fingerprint(
    items
      .filter((item) => item.kind === 'aggregate')
      .map((item) => [
        item.ingredientId ?? '',
        String(item.grams),
        item.sources
          .map((source) => `${source.slotId}~${source.recipeId}`)
          .sort()
          .join(','),
      ]),
  );
}

function signatureOfRows(rows: AggregateRow[]): string {
  return fingerprint(
    rows.map((row) => [
      row.ingredientId,
      String(row.grams),
      row.sources
        .map((source) => `${source.slotId}~${source.recipeId}`)
        .sort()
        .join(','),
    ]),
  );
}

/**
 * 重算（总纲 §2.7 的**手动**重算）：重新聚合 + **勾选按食材继承** + **手工行保留** + 清过期标记。
 * 手工行原样不动（连 id 与勾选一起）——「掌勺者临时加的东西不该被一次重算冲掉」。
 *
 * 只对**进行中**的清单动手：归档的清单是封存的历史，重算它等于篡改买完的账。没有进行中的
 * 清单时返回 null（路由翻成 409）——「重算」按钮只长在清单上，没有清单就没有这个东西可重算。
 */
export function recalculateGroceryList(db: Db, clock: Clock): GroceryList | null {
  const active = activeListRow(db);
  if (!active) return null;
  const listId = active.id;

  const aggregate = aggregateGrocery(db, clock);
  const existing = readGroceryList(db, listId);
  const inherited = new Map(
    existing.items.filter((item) => item.ingredientId !== null).map((item) => [item.ingredientId!, item.checked]),
  );
  const apply = db.transaction((): void => {
    writeAggregateRows(db, listId, aggregate.rows, inherited);
    db.prepare(
      'UPDATE grocery_lists SET stale = 0, stale_reason = NULL, stale_slot_id = NULL, recalculated_at = ?, meal_count = ? WHERE id = ?',
    ).run(clock.now().toISOString(), aggregate.mealCount, listId);
  });
  apply();
  return readGroceryList(db, listId);
}

/**
 * 过期标记（总纲 §2.7：改餐 → 清单标记**过期**）。只改标记与原因，**不动行**：
 * 过期清单上的勾选与手工行正是重算要继承的东西。
 *
 * 存的是**结构**（原因枚举 `stale_reason` + 哪一餐 `stale_slot_id`），不是渲染好的中文：
 * 界面那句「⚠️ （今天午餐的菜单变了），清单过期了」由读接口/界面现拼。存中文有两个必然的坑
 * ——改文案就是改历史数据；而「今天午餐」这种相对叫法会随时间漂移（昨天存的串说的是昨天的事，
 * 永远对不回当时那一餐）。槽位与原因在 schema 上成对（迁移 009 的 CHECK）：槽位类原因必须带槽，
 * 家规改动（没有具体餐）必须不带。
 *
 * 两个入口（**不再是一个按 slotId 拼句子的函数**，因为过期有两种形状）：
 *   * `markGroceryStale`——改餐类，带餐槽 id；
 *   * `markGroceryStaleForRules`——家规改动，没有餐槽。
 * 真正落库的只有 `writeStale` 一处（两个入口只差一个槽位参数）。
 *
 * 没有进行中的清单时是空操作（还没开始买的餐不产生清单，也就没有「过期」可言）——
 * 返回 false 让调用方自己决定要不要说点什么。已经过期时原因覆盖成最新一次的：
 * 警告卡上的那句要说的是「最近一次改的是什么」。
 */
export function markGroceryStale(db: Db, slotId: string, reason: StaleReason): boolean {
  return writeStale(db, reason, slotId);
}

/**
 * 槽位类过期原因（改餐那三种）——从线上枚举里扣掉家规那一档派生，不另拄一份会漂移的值域。
 * 它的入参形状因此与 `markGroceryStaleForRules`（不带槽）分开：服务端 schema 上槽位与原因成对，
 * 类型上也就不该允许「家规类 + 某个槽」这种根本没意义的组合。
 */
export type StaleReason = Exclude<GroceryStaleReason, 'family_rules_changed'>;

/**
 * 改家规（只限会改变聚合结果的那几个值）→ 清单过期。
 *
 * 为什么家规也要标：`leftover_uplift` 直接改变每道菜的克数、两个截止时刻决定
 * 「哪几餐还在可买范围内」（`buyableSlots` 用 `slot.editable`），改了它们，
 * 进行中的清单就静默地与新口径不一致了（#23 评审发现的缺口）。没有具体哪一餐，所以不带槽。
 */
export function markGroceryStaleForRules(db: Db): boolean {
  return writeStale(db, 'family_rules_changed', null);
}

/**
 * 这次家规改动会不会改变清单的聚合结果？——只有它会时才标过期（判据就在本文件里，因为
 * 「聚合读了哪些家规」是清单自己的知识，不是家规表的）。
 *
 * 两个值：
 *   * `leftoverUplift`——上面「聚合自己不算份量」那条的直接依赖：`portionOf` 读它算每道菜的
 *     克数，改了它，**同一份菜单的聚合克数就变了**；
 *   * 两个截止时刻——决定 `slot.editable`，而 `buyableSlots` 用它筛「还在可买范围内的餐」，
 *     改了它，**清单该含哪几餐就变了**。
 *
 * 冷藏期天数不在内（它管的是推荐排除，不影响清单的任何一个数）。日后有新值进入聚合路径
 * （比如留量的适用菜类）也要放进这个判定，否则清单会静默不过期——这正是 #23 评审抓住的缺口。
 */
export function familyRulesAffectGrocery(before: FamilyRules, after: FamilyRules): boolean {
  return (
    before.leftoverUplift !== after.leftoverUplift ||
    before.lunchCutoffHour !== after.lunchCutoffHour ||
    before.dinnerCutoffHour !== after.dinnerCutoffHour
  );
}

/** 落库那一处：只认进行中的清单，没有就空操作 */
function writeStale(db: Db, reason: GroceryStaleReason, slotId: string | null): boolean {
  const active = activeListRow(db);
  if (!active) return false;
  db.prepare('UPDATE grocery_lists SET stale = 1, stale_reason = ?, stale_slot_id = ? WHERE id = ?').run(
    reason,
    slotId,
    active.id,
  );
  return true;
}

/** 买完归档：进行中 → 已归档（勾选态一起封存）。没有进行中的清单时返回 null（路由翻成 409）。 */
export function archiveGroceryList(db: Db, clock: Clock): GroceryList | null {
  const active = activeListRow(db);
  if (!active) return null;
  db.prepare("UPDATE grocery_lists SET status = 'archived', archived_at = ? WHERE id = ?").run(
    clock.now().toISOString(),
    active.id,
  );
  return readGroceryList(db, active.id);
}

// ---------------------------------------------------------------- 行操作（勾选 / 手工行）

/** 行不在进行中的清单里（id 属于归档清单、或根本不存在） */
export class GroceryItemNotFoundError extends Error {
  constructor(readonly itemId: number) {
    super(`这份买菜清单里没有这一行：${itemId}`);
    this.name = 'GroceryItemNotFoundError';
  }
}

/** 想删一条聚合行：它由已定餐聚合而来，重算就会回来（要拿掉它请改餐） */
export class AggregateItemNotDeletableError extends Error {
  constructor(readonly itemId: number) {
    super(`聚合行不能删（它由已定餐聚合而来，改餐后重算自然更新）：${itemId}`);
    this.name = 'AggregateItemNotDeletableError';
  }
}

/** 加一条手工行（总纲 §2.7：掌勺者临时加，不属于任何菜谱，重算时保留） */
export function addManualItem(db: Db, clock: Clock, name: string): GroceryList {
  const list = activeListOrCreate(db, clock);
  const position = nextManualPosition(db, list.id);
  db.prepare(
    `INSERT INTO grocery_items (list_id, kind, ingredient_id, name, grams, checked, needs_relabel, position)
     VALUES (?, 'manual', NULL, ?, NULL, 0, 0, ?)`,
  ).run(list.id, name, position);
  return readGroceryList(db, list.id);
}

function nextManualPosition(db: Db, listId: number): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM grocery_items WHERE list_id = ? AND kind = 'manual'")
    .get(listId) as { next: number };
  return row.next;
}

/** 逐行勾选（买到打个勾）。显式布尔而不是开关切换：两端各翻一次会把状态翻丢。 */
export function setGroceryItemChecked(db: Db, itemId: number, checked: boolean): GroceryList {
  const listId = activeListIdOfItem(db, itemId);
  db.prepare('UPDATE grocery_items SET checked = ? WHERE id = ?').run(checked ? 1 : 0, itemId);
  return readGroceryList(db, listId);
}

/** 删一条**手工行**（聚合行删了重算也会回来，那是改餐的事） */
export function deleteManualItem(db: Db, itemId: number): GroceryList {
  const listId = activeListIdOfItem(db, itemId);
  const row = db.prepare('SELECT kind FROM grocery_items WHERE id = ?').get(itemId) as { kind: string } | undefined;
  if (row?.kind !== 'manual') throw new AggregateItemNotDeletableError(itemId);
  db.prepare('DELETE FROM grocery_items WHERE id = ?').run(itemId);
  return readGroceryList(db, listId);
}

/** 这一行属于哪份**进行中**的清单？归档的清单不再接受改动（封存的东西不该再变）。 */
function activeListIdOfItem(db: Db, itemId: number): number {
  const row = db
    .prepare(
      `SELECT i.list_id, l.status FROM grocery_items i JOIN grocery_lists l ON l.id = i.list_id WHERE i.id = ?`,
    )
    .get(itemId) as { list_id: number; status: string } | undefined;
  if (!row || row.status !== 'active') throw new GroceryItemNotFoundError(itemId);
  return row.list_id;
}

// ---------------------------------------------------------------- 读

/** 已归档的清单数（「买完归档」是常态动作，界面上要能看见它真的存下来了） */
export function archivedGroceryCount(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM grocery_lists WHERE status = 'archived'").get() as {
    count: number;
  };
  return row.count;
}

function readGroceryList(db: Db, listId: number): GroceryList {
  const row = db.prepare('SELECT * FROM grocery_lists WHERE id = ?').get(listId) as ListRow;
  const itemRows = db
    .prepare(
      `SELECT id, kind, ingredient_id, name, grams, checked, needs_relabel
         FROM grocery_items WHERE list_id = ?
        ORDER BY CASE kind WHEN 'aggregate' THEN 0 ELSE 1 END, position`,
    )
    .all(listId) as {
    id: number;
    kind: 'aggregate' | 'manual';
    ingredient_id: string | null;
    name: string;
    grams: number | null;
    checked: number;
    needs_relabel: number;
  }[];

  const categories = categoryByIngredient(db);
  const sourcesByItem = readSources(db, listId);

  const items: GroceryItem[] = itemRows.map((item) => ({
    id: item.id,
    kind: item.kind,
    ingredientId: item.ingredient_id,
    name: item.name,
    grams: item.grams,
    needsRelabel: item.needs_relabel === 1,
    checked: item.checked === 1,
    category: item.ingredient_id === null ? null : (categories.get(item.ingredient_id) ?? OTHER_LABEL),
    sources: item.kind === 'aggregate' ? (sourcesByItem.get(item.id) ?? []) : [],
  }));

  return {
    id: row.id,
    status: row.status,
    stale: row.stale === 1,
    staleReason: row.stale_reason,
    staleSlotId: row.stale_slot_id,
    createdAt: row.created_at,
    recalculatedAt: row.recalculated_at,
    archivedAt: row.archived_at,
    mealCount: row.meal_count,
    items,
    exchangeNote: groceryExchangeNote(db),
  };
}

/**
 * 聚合行的来源（一次取齐，避免每行一条查询）。菜名现读菜谱表：菜改名了行内的来源跟着变
 * ——存字符串就是存一份会与菜单漂移的快照。
 */
function readSources(db: Db, listId: number): Map<number, GroceryItemSource[]> {
  const rows = db
    .prepare(
      `SELECT s.item_id, s.slot_id, s.recipe_id, r.name AS recipe_name
         FROM grocery_item_sources s
         JOIN recipes r ON r.id = s.recipe_id
         JOIN grocery_items i ON i.id = s.item_id
        WHERE i.list_id = ?
        ORDER BY s.item_id, s.position`,
    )
    .all(listId) as { item_id: number; slot_id: string; recipe_id: string; recipe_name: string }[];

  const byItem = new Map<number, GroceryItemSource[]>();
  for (const row of rows) {
    const parsed = parseSlotId(row.slot_id);
    const source: GroceryItemSource = {
      slotId: row.slot_id,
      // 落库的行都由 buyableSlots 产出（合法 slot id），解析不了只可能是外部手改的库：
      // 不抛错，回落到空日期，让清单照常读得出来（一行来源难看，好过整页打不开）
      date: parsed?.date ?? '',
      meal: parsed?.meal ?? 'lunch',
      recipeId: row.recipe_id,
      recipeName: row.recipe_name,
    };
    const list = byItem.get(row.item_id);
    if (list) list.push(source);
    else byItem.set(row.item_id, [source]);
  }
  return byItem;
}

/**
 * 底部那句生熟换算参考（原型 v1 的位置）：**从互换表现算**，不在代码里硬编码数字——
 * 表改了（或标准修订），界面跟着变。
 *
 * 两条参考各有出处：
 *   * 米生:熟 = 米饭（粳米）110 g ÷ 大米 50 g = 2.2（原型写 1:2.2，同一个数）；
 *   * 肉熟重 = 酱牛肉 35 g（熟重）÷ 瘦猪肉 50 g（生重）= 0.7。原型写的是 ×0.65——那是原型
 *     手写的一个约数，本项目以互换表的数（0.7）为准（ADR-0004：数值口径只有规则表一处）。
 * 查不到就只留「生重为准」——宁可少说，也不说一个没有出处的数。
 */
export function groceryExchangeNote(db: Db): string {
  const items = exchangeTable(db).flatMap((group) => group.items);
  const ratio = (fromId: string, toId: string): number | undefined => {
    const from = items.find((item) => item.id === fromId);
    const to = items.find((item) => item.id === toId);
    if (!from || !to || from.groupId !== to.groupId) return undefined;
    return to.grams / from.grams;
  };

  const parts = ['生重为准'];
  const rice = ratio('staple_rice_raw', 'staple_rice_japonica');
  if (rice !== undefined) parts.push(`米生:熟 ≈ 1:${round1(rice)}`);
  const meat = ratio('meat_pork_lean', 'meat_braised_beef');
  if (meat !== undefined) parts.push(`肉熟重约 ×${round1(meat)}`);
  return parts.join(' · ');
}
