import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import type { CoolingDish, DinerRef, DishFeedback, FeedbackTag, FeedbackVerdict, MenuDish, ReviewMeal } from '../wire-types.js';
import { addDays, familyDate } from './family-time.js';
import { coolOffDays } from './family-rules.js';
import { findMember, MemberNotFoundError } from './members.js';
import { findRecipe } from './recipes.js';
import { hasMealPassed, listSlotEvents, parseSlotId } from './slots.js';

/**
 * 反馈、冷藏期与近 30 天反馈摘要（总纲 §2.5、§4①；ADR-0005）。
 *
 * 这个文件是**两种机制的唯一实现处**，而它们是两条不同的路（ADR-0005 的硬约束）：
 * 1. **点踩 → 冷藏期（硬排除）**：某道菜被任一本餐用餐者点踩，`coolOffDays`（家规，默认 14）天内
 *    不进整餐推荐与换菜候选，**到期自动解除**（不靠清理任务：判定就是「`updated_on` 落在窗口内」，
 *    时间一走它自己就解除了）。布尔语义，不叠加、不分程度。
 * 2. **点赞与带标签的反馈 → 近 30 天文本摘要（软信号）**：聚合成几句中文进推荐 prompt，**零数值权重**。
 *
 * ⚠️ **两条路不能合并成一个分数**（ADR-0005 钉死的形态）：冷藏期是「这段时间别再端上来」的
 * 硬规则，摘要是「这几样最近吃得不太如意」的背景信息。把点踩折成一个惩罚系数、再让排序去乘，
 * 就回到了「调参换不来可感知收益」的老路，而且「这道菜为什么没出现」再也答不清。
 *
 * 反馈**不是留痕**：留痕 append-only 记的是菜单的变化，而反馈可以改主意（点错重按）。
 * 所以这里是一张普通表，重按是 UPDATE——见迁移 006 的说明。
 */

/**
 * 快捷标签值域（总纲 §2.5、CONTEXT「快捷标签」）：**封闭**，与迁移 006 的 CHECK 同源。
 * 界面的选项表也从这里取（`wire-types.ts` 的 `FeedbackTag` 是它的类型侧同一份值域）。
 */
export const FEEDBACK_TAGS: readonly FeedbackTag[] = ['太油', '太甜', '量太多', '量太少'] as const;

/** 近 30 天反馈摘要的窗口（总纲 §4①：点赞与带标签的反馈聚合成近 30 天软信号） */
export const FEEDBACK_SUMMARY_DAYS = 30;

/** 快捷标签就这 4 个（总纲 §2.5 的「3–4 个」）：家人嘴里真会说的那几句 */
export function isFeedbackTag(value: string): value is FeedbackTag {
  return (FEEDBACK_TAGS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------- 冷藏期（硬排除）

/**
 * 当前**正在冷藏期**的菜 → 到期日（家庭日历日；当天不再冷藏）。
 *
 * 口径：窗口 = 最近 `coolOffDays` 个家庭日历日（含今天），只看 `verdict='dislike'` 的反馈——
 * 点赞永远不触发排除。即「点踩当天起算 `coolOffDays` 天」：06-01 点踩、家规 14 天 →
 * 06-01..06-14 都在冷藏，**06-15 自动解除**（到期日 = 点踩那天 + `coolOffDays`，当天不再冷藏）。
 * 窗口外（以及更早点过踩、后来改主意点了赞）的菜自动回来：
 * 判定是现算的，没有「到期清理」这一步，所以也不存在「清理任务没跑导致解不了冻」。
 *
 * 冷却的是**菜**不是人：任一本餐用餐者点踩即触发（ADR-0005 的布尔语义），
 * 所以这里只按 recipe_id 聚合，不看是谁点的。
 */
export function coolingDishes(db: Db, clock: Clock, days = coolOffDays(db)): Map<string, string> {
  const today = familyDate(clock.now());
  const from = addDays(today, -(days - 1));
  const rows = db
    .prepare(
      `SELECT recipe_id, MAX(updated_on) AS last_on
         FROM dish_feedback
        WHERE verdict = 'dislike' AND updated_on BETWEEN ? AND ?
        GROUP BY recipe_id`,
    )
    .all(from, today) as { recipe_id: string; last_on: string }[];
  // 到期日 = 最后一次点踩那天 + coolOffDays（当天还在冷藏：updated_on + days 是解除那天）
  return new Map(rows.map((row) => [row.recipe_id, addDays(row.last_on, days)]));
}

/** 在冷藏期的菜（界面用：说清「这道为什么不在推荐里」），按到期日、菜名排好序 */
export function coolingDishList(db: Db, clock: Clock, days = coolOffDays(db)): CoolingDish[] {
  const cooling = coolingDishes(db, clock, days);
  const dishes: CoolingDish[] = [];
  for (const [recipeId, until] of cooling) {
    const recipe = findRecipe(db, recipeId);
    // 菜谱行不删（退役也保留），查不到只可能是数据被手改过；宁可不显示，也不编一个菜名
    if (recipe) dishes.push({ recipeId, name: recipe.name, until });
  }
  return dishes.sort((a, b) => (a.until === b.until ? a.name.localeCompare(b.name, 'zh') : a.until < b.until ? 1 : -1));
}

// ---------------------------------------------------------------- 近 30 天文本摘要（软信号）

/**
 * 近 30 天反馈 → 几句中文（进推荐 prompt 的【近 30 天反馈】段）。
 *
 * 四条纪律：
 *   * **判定按自己的机制走，不重复表达**：`like` 写成「某某点过赞」；`dislike` **不写成句子**——
 *     它已经由冷藏期用硬排除表达完了（ADR-0005）。
 *   * **标签不论赞踩都进摘要**：标签回答的是另一个问题——「为什么」太油/太甜/量太多（总纲 §2.5、
 *     CONTEXT「快捷标签」）。冷藏期是布尔的、只答「还推不推」，答不了这个问题。
 *     这也是界面上唯一能选标签的两条路（菜单阶段点踩 + 标签、餐后回顾赞/踩 + 标签）
 *     的产出必须落到的位置：界面上选了「太油」却不进摘要，等于这个机制不存在。
 *   * **聚合到「菜 × 标签 × 多少人说过」，不是流水账**：`红烧排骨「太油」（妈妈、爸爸）` 一句话
 *     顶得上两条重复记录；人数不进任何排序公式，它只是这句话的一部分。
 *   * **窗口是家庭日历日**（迁移 006 的 `updated_on`）：近 30 天是「家里的近 30 天」，
 *     不是 UTC 的 30×24 小时。
 *
 * 返回 `[]` = 这 30 天没什么可说的（prompt 里就不写这一段，不留空标题）。
 */
export function feedbackSummary(db: Db, clock: Clock, days = FEEDBACK_SUMMARY_DAYS): string[] {
  const today = familyDate(clock.now());
  const from = addDays(today, -(days - 1));

  const rows = db
    .prepare(
      `SELECT f.recipe_id, r.name AS recipe_name, f.member_id, m.name AS member_name, f.verdict, t.tag
         FROM dish_feedback f
         JOIN recipes r ON r.id = f.recipe_id
         JOIN members m ON m.id = f.member_id
         LEFT JOIN dish_feedback_tags t ON t.feedback_id = f.id
        WHERE f.updated_on BETWEEN ? AND ?
        ORDER BY f.recipe_id, f.member_id, t.tag`,
    )
    .all(from, today) as {
    recipe_id: string;
    recipe_name: string;
    member_id: string;
    member_name: string;
    verdict: FeedbackVerdict;
    tag: FeedbackTag | null;
  }[];

  // 先按菜聚合：标签 → 谁说过（去重），以及谁点过赞
  // 标签用 Map 的插入序：SQL 里 `ORDER BY t.tag` 已把同一道菜的标签排好，
  // prompt 因此可复现（同一库两次生成的摘要一字不差）
  interface Aggregated {
    labels: Map<string, Set<string>>;
    likedBy: Set<string>;
  }
  const byRecipe = new Map<string, { name: string; info: Aggregated }>();
  for (const row of rows) {
    let entry = byRecipe.get(row.recipe_id);
    if (!entry) {
      entry = { name: row.recipe_name, info: { labels: new Map(), likedBy: new Set() } };
      byRecipe.set(row.recipe_id, entry);
    }
    // 判定：只有点赞写成句子（点踩的后果由冷藏期表达，见上面的纪律）
    if (row.verdict === 'like') entry.info.likedBy.add(row.member_name);
    // 标签：**不论赞踩**都进摘要（这是「为什么」的唯一出口）
    if (row.tag !== null) {
      const who = entry.info.labels.get(row.tag);
      if (who) who.add(row.member_name);
      else entry.info.labels.set(row.tag, new Set([row.member_name]));
    }
  }

  const lines: string[] = [];
  for (const entry of byRecipe.values()) {
    const parts: string[] = [];
    if (entry.info.likedBy.size > 0) parts.push(`${[...entry.info.likedBy].join('、')}点过赞`);
    for (const [tag, who] of entry.info.labels) {
      parts.push(`「${tag}」（${[...who].join('、')}）`);
    }
    if (parts.length > 0) lines.push(`${entry.name}：${parts.join('，')}。`);
  }
  // 顺序稳定（prompt 可复现：同一库两次生成的摘要一字不差）
  return lines.sort((a, b) => a.localeCompare(b, 'zh'));
}

// ---------------------------------------------------------------- 餐后回顾（饭后餐卡）

/** 餐后回顾卡的默认窗口：最近 3 天（含今天）——够覆盖“上一顿没评的”与昨天的饭 */
export const REVIEW_DAYS = 3;

/**
 * 「饭后餐卡」：窗口内**已经上桌**的餐（过了截止时刻）与它们当前收到的反馈。
 *
 * 口径与 `recentDishes` 一致（每餐槽只认当前有效的那条事件、过了截止时刻才算吃过）：
 * 「这一餐吃过什么」在整仓只有一个真相——事件流。
 *
 * 为什么要一个专用读口而不是把已过的餐塞回 `/api/slots`：那个接口是「下一餐优先」的
 * 工作列表（已过截止的餐次刻意不出现在那里），回顾关心的刚好是它们的反面。
 * 两条取数语义分开，各自不必为对方妥协（也不会让「今天还有哪些餐没定」多出历史噪音）。
 */
export function mealsToReview(db: Db, clock: Clock, days = REVIEW_DAYS): ReviewMeal[] {
  const today = familyDate(clock.now());
  const from = addDays(today, -(days - 1));
  const rows = db
    .prepare('SELECT DISTINCT slot_id FROM meal_events WHERE slot_date BETWEEN ? AND ?')
    .all(from, today) as { slot_id: string }[];

  const meals: ReviewMeal[] = [];
  for (const { slot_id } of rows) {
    const parsed = parseSlotId(slot_id);
    if (!parsed) continue;
    // 还没上桌的餐不进回顾：饭前评菜是「菜单阶段的反馈」，它有自己的入口（菜单卡/编辑器）
    if (!hasMealPassed(db, clock, parsed.date, parsed.meal)) continue;
    const history = listSlotEvents(db, slot_id);
    const last = history[history.length - 1];
    // 取消的一餐没吃过（也不该请人来评）；没有菜单的一餐同理
    if (!last || last.type === 'cancel') continue;
    meals.push({
      slotId: slot_id,
      date: parsed.date,
      meal: parsed.meal,
      diners: last.diners as DinerRef[],
      dishes: last.dishes as MenuDish[],
      feedback: slotFeedback(db, slot_id),
    });
  }
  // 最近的一餐排前面（同一天午餐没评的排在晚餐前：按发生的先后往后看）
  return meals.sort((a, b) =>
    a.date === b.date ? b.meal.localeCompare(a.meal) : a.date < b.date ? 1 : -1,
  );
}

// ---------------------------------------------------------------- 写入 / 读取 / 撤回

export class UnknownSlotIdError extends Error {
  constructor(readonly slotId: string) {
    super(`餐槽 id 必须是 'YYYY-MM-DD:lunch|dinner'：${slotId}`);
    this.name = 'UnknownSlotIdError';
  }
}

export class UnknownRecipeError extends Error {
  constructor(readonly recipeId: string) {
    super(`菜谱库里没有这道菜：${recipeId}`);
    this.name = 'UnknownRecipeError';
  }
}

export class InvalidFeedbackTagError extends Error {
  constructor(readonly tag: string) {
    super(`不是快捷标签：${tag}`);
    this.name = 'InvalidFeedbackTagError';
  }
}

/** 这道菜不在那一餐的菜单里——给别的菜提意见是调用错误，不是「新反馈」 */
export class DishNotInSlotError extends Error {
  constructor(
    readonly slotId: string,
    readonly recipeId: string,
  ) {
    super(`这一餐的菜单里没有这道菜：${slotId} / ${recipeId}`);
    this.name = 'DishNotInSlotError';
  }
}

/** 撤回一条本来就没有的反馈 */
export class FeedbackNotFoundError extends Error {
  constructor(readonly slotId: string, readonly recipeId: string, readonly memberId: string) {
    super(`这条反馈本来就没有：${slotId} / ${recipeId} / ${memberId}`);
    this.name = 'FeedbackNotFoundError';
  }
}

export interface StoreFeedbackInput {
  slotId: string;
  recipeId: string;
  memberId: string;
  verdict: FeedbackVerdict;
  tags?: string[];
}

/**
 * 写一条反馈（同一人 × 同一餐 × 同一道菜重复提交 = **改主意**，UPDATE 那一行）。
 *
 * 三道关卡按「更根本的先报」排：
 *   1. 餐槽 id 形状、菜在菜谱库里（`UnknownRecipeError`）、人在家人列表里；
 *   2. **这道菜在那一餐的菜单里**——反馈挂在「这一餐的这道菜」上，给别的菜提意见是调用错误
 *      （与换菜候选的 `DishNotInMenuError` 同一纪律：宁可拒收，也不落一条解释不了的记录）；
 *   3. 标签值域封闭（迁移 006 的 CHECK 是最后一道，这里先给出可读的错误）。
 */
export function storeFeedback(db: Db, clock: Clock, input: StoreFeedbackInput): DishFeedback {
  const parsed = parseSlotId(input.slotId);
  if (!parsed) throw new UnknownSlotIdError(input.slotId);
  if (!findRecipe(db, input.recipeId)) throw new UnknownRecipeError(input.recipeId);
  if (!findMember(db, input.memberId)) throw new MemberNotFoundError(input.memberId);
  if (!dishOnMenu(db, input.slotId, input.recipeId)) {
    throw new DishNotInSlotError(input.slotId, input.recipeId);
  }
  const tags = [...new Set(input.tags ?? [])];
  for (const tag of tags) {
    if (!isFeedbackTag(tag)) throw new InvalidFeedbackTagError(tag);
  }

  const now = clock.now().toISOString();
  const today = familyDate(clock.now());
  const write = db.transaction((): number => {
    db.prepare(
      `INSERT INTO dish_feedback (recipe_id, slot_id, member_id, verdict, created_at, updated_at, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slot_id, recipe_id, member_id)
       DO UPDATE SET verdict = excluded.verdict, updated_at = excluded.updated_at, updated_on = excluded.updated_on`,
    ).run(input.recipeId, input.slotId, input.memberId, input.verdict, now, now, today);
    const row = db
      .prepare('SELECT id FROM dish_feedback WHERE slot_id = ? AND recipe_id = ? AND member_id = ?')
      .get(input.slotId, input.recipeId, input.memberId) as { id: number };
    // 标签随判定整体替换：改成点赞时旧标签一并清掉（「太油」说的是那一盘，判定换了它就没意义了）
    db.prepare('DELETE FROM dish_feedback_tags WHERE feedback_id = ?').run(row.id);
    const insertTag = db.prepare('INSERT INTO dish_feedback_tags (feedback_id, tag) VALUES (?, ?)');
    for (const tag of tags) insertTag.run(row.id, tag);
    return row.id;
  });
  const id = write();
  return feedbackById(db, id)!;
}

/** 撤回一条反馈（按错了/不想说了）。撤回之后这道菜不再受它影响（冷藏期、摘要都少这一条）。 */
export function deleteFeedback(db: Db, input: { slotId: string; recipeId: string; memberId: string }): void {
  const result = db
    .prepare('DELETE FROM dish_feedback WHERE slot_id = ? AND recipe_id = ? AND member_id = ?')
    .run(input.slotId, input.recipeId, input.memberId);
  if (result.changes === 0) throw new FeedbackNotFoundError(input.slotId, input.recipeId, input.memberId);
}

/** 某餐槽的反馈（按菜、家人排序）——餐后回顾的餐卡按它回显「谁说了什么」 */
export function slotFeedback(db: Db, slotId: string): DishFeedback[] {
  const rows = db
    .prepare(
      `SELECT f.id FROM dish_feedback f
        WHERE f.slot_id = ?
        ORDER BY f.recipe_id, f.member_id`,
    )
    .all(slotId) as { id: number }[];
  return rows.map((row) => feedbackById(db, row.id)).filter((item): item is DishFeedback => item !== undefined);
}

/** `GET /api/feedback?days=`：窗口内的反馈（界面的「谁最近说了什么」）+ 冷藏中的菜 */
export function listFeedback(db: Db, clock: Clock, days = FEEDBACK_SUMMARY_DAYS): DishFeedback[] {
  const today = familyDate(clock.now());
  const from = addDays(today, -(days - 1));
  const rows = db
    .prepare(
      `SELECT id FROM dish_feedback
        WHERE updated_on BETWEEN ? AND ?
        ORDER BY updated_on DESC, slot_id, recipe_id, member_id`,
    )
    .all(from, today) as { id: number }[];
  return rows.map((row) => feedbackById(db, row.id)).filter((item): item is DishFeedback => item !== undefined);
}

interface FeedbackRow {
  id: number;
  recipe_id: string;
  recipe_name: string;
  recipe_kind: DishFeedback['recipeKind'];
  slot_id: string;
  member_id: string;
  member_name: string;
  verdict: FeedbackVerdict;
  updated_at: string;
}

function feedbackById(db: Db, id: number): DishFeedback | undefined {
  const row = db
    .prepare(
      `SELECT f.id, f.recipe_id, r.name AS recipe_name, r.kind AS recipe_kind, f.slot_id,
              f.member_id, m.name AS member_name, f.verdict, f.updated_at
         FROM dish_feedback f
         JOIN recipes r ON r.id = f.recipe_id
         JOIN members m ON m.id = f.member_id
        WHERE f.id = ?`,
    )
    .get(id) as FeedbackRow | undefined;
  if (!row) return undefined;
  const tags = db
    .prepare('SELECT tag FROM dish_feedback_tags WHERE feedback_id = ?')
    .all(id) as { tag: FeedbackTag }[];
  // 标签按 FEEDBACK_TAGS 的顺序回：界面的选项顺序与回显顺序一致（不按字符序随机排）
  const ordered = FEEDBACK_TAGS.filter((tag) => tags.some((item) => item.tag === tag));
  return {
    memberId: row.member_id,
    memberName: row.member_name,
    slotId: row.slot_id,
    recipeId: row.recipe_id,
    recipeName: row.recipe_name,
    recipeKind: row.recipe_kind,
    verdict: row.verdict,
    tags: [...ordered],
    updatedAt: row.updated_at,
  };
}

/**
 * 这道菜在不在那一餐的菜单上。**只看「当前有效」的那条事件**（与 `recentDishes` 同一口径）：
 * 被改餐改掉的菜不能收反馈——它已经不在这一餐里了。
 */
function dishOnMenu(db: Db, slotId: string, recipeId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1
         FROM meal_events e
         JOIN meal_event_dishes d ON d.seq = e.seq
        WHERE e.slot_id = ?
          AND e.type <> 'cancel'
          AND e.seq = (SELECT MAX(e2.seq) FROM meal_events e2 WHERE e2.slot_id = e.slot_id)
          AND d.recipe_id = ?`,
    )
    .get(slotId, recipeId);
  return row !== undefined;
}
