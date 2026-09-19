import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import type { LlmClient } from '../llm/types.js';
import type { PromotionInput, PromotionRecord, PromotionResult, Recipe, RecipeCuisine, TasteTag } from '../wire-types.js';
import { findRecipe } from './recipes.js';
import { hasMealPassed } from './slots.js';
import { findMember, MemberNotFoundError } from './members.js';
import {
  PROMOTION_PROMPT_VERSION,
  rewriteRecipe,
  type PromotionRewrite,
} from '../llm/promotion-schema.js';

// 线上形状定义在 wire-types.ts（前端也从那里取）
export type { PromotionInput, PromotionResult, PromotionRecord } from '../wire-types.js';

/**
 * 转正流程（总纲 §2.8、spec S6；ADR-0006）。
 *
 * 一句话：**外部菜谱被预定上桌 → 餐后回顾里掌勺者点「转正」→ 可口述差异 → LLM 在原菜谱上
 * 改写成家里版本 → 进家庭库 + 推荐池**。
 *
 * 三处判定各有出处，都不是随手加的：
 *
 * 1. **必须「已经吃过」**（`servedMealOf`）。ADR-0006 的转正门槛是「家里做过、家人吃过」——
 *    状态机 draft → active 的语义是「这道菜经过了餐桌的检验」，不是「谁点了一下」。
 *    判定口径与餐后回顾、`recentDishes` 完全一致：某餐槽**最后一条非取消事件**的菜单里有这道菜，
 *    且那一餐已过截止时刻（`hasMealPassed`，家规午 14 / 晚 21）。于是「回顾页上看得见这道菜」
 *    与「能对它点转正」是同一个事实的两个面，界面不必另立一套规则。
 * 2. **只转草稿**。家庭菜谱（active）已经转过了，退役菜谱（retired）是「家里不想再做了」——
 *    把它们改写成「新版本」等于绕过状态机（ADR-0006：退役不进推荐、历史保留）。
 * 3. **LLM 改写是整个动作的一部分，失败就整次失败**（502，草稿原样留着）。这不是「能降级」的
 *    地方：没有改写就没有「家里版本」，而 0 克的待重标项必须在这一步被重标掉——半截落库
 *    （状态变了、措辞没变/克数没变）会让台账说不出到底改没改。
 *
 * **就地改写同一行**（不新建行）：菜谱 id 被菜单、留痕事件、反馈引用着（`meal_events` 是
 * append-only，删不掉也改不了），换 id 等于把「那道菜」的历史割成两截。菜名/别名/来源
 * 也保持不变——身份不是这次编辑的对象（来源 `source` 是「这道菜从哪来」的如实记录，
 * 转正改的是做法，不是出身）。原样保留的还有 `scaling` / `rawCookedAnchor`：
 * 模型不该发明生熟换算锚点，缩放规则也不是它能判断的（见下面的 `promoteRecipe` 事务第 ④ 步）。
 */

/**
 * 口述差异的长度上限（掌勺者说一两句就够；超长输入只会让 prompt 变噪音）。
 *
 * 这里**只定义、不截断**：真正把关的是 `api/recipes.ts` 的 Zod（`max(500, ...)` → 400）。
 * 原先 `promoteRecipe` 还在这里 `.slice(0, …)` 一道，但那个 slice 在 Zod 之后**不可达**
 * （HTTP 入口进不来、能进来的都是 ≤500），留着只会让人以为「超长会被默默截断」——它不会，
 * 而是会报 400。领域函数只保留这一个数字供路由层引用。
 */
export const MAX_DIFFERENCES_LENGTH = 500;

/** 菜谱不在库里 */
export class RecipeNotFoundError extends Error {
  constructor(readonly recipeId: string) {
    super(`菜谱库里没有这道菜：${recipeId}`);
    this.name = 'RecipeNotFoundError';
  }
}

/** 不是草稿（已经是家庭菜谱 / 已退役）——转正只对草稿有意义 */
export class RecipeNotDraftError extends Error {
  constructor(
    readonly recipeId: string,
    readonly status: string,
  ) {
    super(`只有草稿能转正，这道菜当前状态是 ${status}：${recipeId}`);
    this.name = 'RecipeNotDraftError';
  }
}

/** 这道菜还没上过桌（ADR-0006 的转正门槛：家里做过、家人吃过） */
export class RecipeNotServedError extends Error {
  constructor(readonly recipeId: string) {
    super(`这道菜还没上过桌（过了餐次截止时刻才算吃过）：${recipeId}`);
    this.name = 'RecipeNotServedError';
  }
}

/** LLM 改写失败（调用失败或形状不合）——整次转正失败，草稿原样留着 */
export class PromotionRewriteFailedError extends Error {
  constructor(
    readonly recipeId: string,
    readonly notes: string[],
  ) {
    super(`LLM 没能把这道菜改写成家里版本，草稿未改动：${recipeId}`);
    this.name = 'PromotionRewriteFailedError';
  }
}

/** 这道菜**最近一次上桌**的那一餐（哪一餐槽、什么日期、已过截止时刻）。
 *
 * 「上桌」的判定与 `recentDishes`/`mealsToReview` 同一套：某餐槽的最后一条事件说了算，
 * 取消的事件把餐槽退回未定（那一餐没吃过）。返回 `undefined` = 还没上过桌。
 *
 * 只看**当前有效**的那条事件，而不是「历史上任何一次菜单里出现过」：家里改过餐
 * （最后把这道菜换掉了）就不算「这道菜上过桌」——餐后回顾里也不会出现它，
 * 两处判定必须同源，否则会出现「回顾页上看不见它、却能转正」这种说不清的界面。
 */
export function servedMealOf(
  db: Db,
  clock: Clock,
  recipeId: string,
): { slotId: string; date: string; meal: 'lunch' | 'dinner' } | undefined {
  const rows = db
    .prepare(
      `SELECT e.slot_id, e.slot_date, e.meal, e.type
         FROM meal_events e
         JOIN meal_event_dishes d ON d.seq = e.seq
        WHERE d.recipe_id = ?
          AND e.seq = (SELECT MAX(e2.seq) FROM meal_events e2 WHERE e2.slot_id = e.slot_id)
        ORDER BY e.slot_date DESC, e.meal DESC`,
    )
    .all(recipeId) as { slot_id: string; slot_date: string; meal: 'lunch' | 'dinner'; type: string }[];

  for (const row of rows) {
    // 最后一条事件是取消 = 那一餐退回了未定，这道菜没上桌
    if (row.type === 'cancel') continue;
    if (!hasMealPassed(db, clock, row.slot_date, row.meal)) continue;
    return { slotId: row.slot_id, date: row.slot_date, meal: row.meal };
  }
  return undefined;
}

/**
 * 转正：状态机 draft → active + LLM 改写 + 台账留痕。
 *
 * 顺序（先问 LLM 再落库）不是随意的：LLM 失败时**库必须一个字节都没动**——状态已翻、
 * 菜谱还是老的，是最糟的一种中间态（用户看到的界面与库里的真相不一致）。
 * 所以库的写入全部收在最后那个事务里，且事务里只做「把已经校验过的东西写下去」。
 */
export async function promoteRecipe(
  db: Db,
  clock: Clock,
  llm: LlmClient,
  recipeId: string,
  input: PromotionInput = {},
): Promise<PromotionResult> {
  const recipe = findRecipe(db, recipeId);
  if (!recipe) throw new RecipeNotFoundError(recipeId);
  if (recipe.status !== 'draft') throw new RecipeNotDraftError(recipeId, recipe.status);

  const served = servedMealOf(db, clock, recipeId);
  if (!served) throw new RecipeNotServedError(recipeId);

  if (input.memberId !== undefined) {
    // 用领域函数而不是手写 `SELECT 1 FROM members`（同一张表的读取只留一个真相）
    if (!findMember(db, input.memberId)) throw new MemberNotFoundError(input.memberId);
  }

  // 不截断：长度上限由路由层的 Zod（`max(MAX_DIFFERENCES_LENGTH)`）把关（见常量的注释）。
  // 领域层再 slice 一次就成了永不可达的死代码，而它看起来又像一个真实门槛。
  const differences = (input.differences ?? '').trim();
  const outcome = await rewriteRecipe(llm, { recipe, differences, cuisine: input.cuisine });
  if (!outcome.rewrite) throw new PromotionRewriteFailedError(recipeId, outcome.notes);

  const rewrite = outcome.rewrite;
  const apply = db.transaction((): void => {
    // ① 菜谱本体：kind/effort/cuisine/steps 用改写值（steps 空串回退原文，见 merge 规则），
    //    状态翻到 active——这一行就是「进家庭库 + 推荐池」的全部机制（ADR-0006：池子 = 状态）
    const cuisineTo = input.cuisine ?? rewrite.cuisine ?? recipe.cuisine ?? null;
    db.prepare('UPDATE recipes SET kind = ?, effort = ?, status = ?, cuisine = ?, steps = ? WHERE id = ?').run(
      rewrite.kind,
      rewrite.effort,
      'active',
      cuisineTo,
      mergeSteps(rewrite, recipe),
      recipeId,
    );
    // ② 口味：改写给了就用改写的（已过封闭五标签过滤），没给就保持原样——
    //    「没提口味」不等于「这道菜没有口味」
    const tastes = normalizeTastes(rewrite.tastes, recipe.tastes);
    db.prepare('DELETE FROM recipe_tastes WHERE recipe_id = ?').run(recipeId);
    for (const taste of tastes) {
      db.prepare('INSERT INTO recipe_tastes (recipe_id, taste) VALUES (?, ?)').run(recipeId, taste);
    }
    // ③ 适季月份：改写给了就用，没给保持原样（与口味同一语义）
    if (rewrite.seasonMonths && rewrite.seasonMonths.length > 0) {
      db.prepare('DELETE FROM recipe_season_months WHERE recipe_id = ?').run(recipeId);
      for (const month of [...new Set(rewrite.seasonMonths)].sort((a, b) => a - b)) {
        db.prepare('INSERT OR IGNORE INTO recipe_season_months (recipe_id, month) VALUES (?, ?)').run(recipeId, month);
      }
    }
    // ④ 食材项：**整体替换**（顺序照改写给的那份）。`scaling` 与 `raw_cooked_anchor` 从原项继承
    //    ——模型不发明生熟换算锚点（那是 WS/T 554 的引用），缩放规则也不是它能判断的。
    //    「不放蒜」写成 0 克的项在这里**被丢掉**：库里的 0 只有一种含义——「待 LLM 重标」
    //    （迁移 005），而转正后不能再留一个未定的 0；转正的结果是一份确认过的家庭菜谱，
    //    不做的食材就不在清单里（「确认不放」是这次改写的一个**结论**，不落成库里的状态）。
    const previous = new Map(recipe.ingredients.map((item) => [item.name, item]));
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
    // 位置按**正向克数**的先后重排：0 克项被丢掉后不能留空洞（position 有 UNIQUE 约束，
    // 且「第 0 项食材」这种顺序是有意义的——主料在前，`poolEntryOf` 的主料判断靠它）
    let position = 0;
    for (const item of rewrite.ingredients) {
      if (item.grams <= 0) continue;
      const before = previous.get(item.name)!;
      db.prepare(
        `INSERT INTO recipe_ingredients
           (recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor, source_quantity)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(recipeId, before.ingredientId, position, roundGrams(item.grams), before.scaling, before.rawCookedAnchor);
      position += 1;
    }
    // ⑤ 台账：这一次编辑的留痕（谁、何时、口述了什么、菜系从什么改成什么、哪个模型改的）
    db.prepare(
      `INSERT INTO recipe_promotions
         (recipe_id, promoted_at, member_id, differences, cuisine_from, cuisine_to,
          llm_model, llm_prompt_version, llm_latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recipeId,
      clock.now().toISOString(),
      input.memberId ?? null,
      differences,
      recipe.cuisine,
      cuisineTo,
      outcome.model ?? llm.model,
      PROMOTION_PROMPT_VERSION,
      outcome.latencyMs,
    );
  });
  apply();

  const updated = findRecipe(db, recipeId)!;
  return {
    recipe: updated,
    llm: {
      model: outcome.model ?? llm.model,
      promptVersion: PROMOTION_PROMPT_VERSION,
      latencyMs: outcome.latencyMs,
      // 转正没有「降级」这一档：LLM 失败就整次失败（见文件头第 3 条）
      degraded: false,
    },
    notes: outcome.notes,
  };
}

/** 做法步骤：改写给了非空白就用它，否则保留原文（「不改做法」与「模型没给做法」是同一处理） */
function mergeSteps(rewrite: PromotionRewrite, recipe: Recipe): string {
  const steps = rewrite.steps?.trim() ?? '';
  return steps === '' ? recipe.steps : steps;
}

/** 口味：改写给了就用（已过滤到封闭五标签），没给就保留原文的顺序与内容 */
function normalizeTastes(tastes: string[], fallback: TasteTag[]): TasteTag[] {
  return tastes.length > 0 ? (tastes as TasteTag[]) : fallback;
}

/** 克数取一位小数（库里的基准是人手写的整洁数字，模型给 162.34 这种精度没有意义） */
function roundGrams(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------- 台账读取

/**
 * 某道菜的转正史（时间倒序）。界面与测试用它回答「这道菜是谁按谁的口述改出来的」。
 *
 * 返回形状直接用线上形状（`wire-types.ts` 的 `PromotionRecord`）：台账只有这一个读口，
 * 再定义一个领域形状就是让两份定义各自漂移（ADR-0002：线上形状只在 wire-types 定义一处）。
 */
export function promotionsOf(db: Db, recipeId: string): PromotionRecord[] {
  const rows = db
    .prepare(
      `SELECT p.recipe_id, p.promoted_at, p.member_id, m.name AS member_name, p.differences,
              p.cuisine_from, p.cuisine_to, p.llm_model, p.llm_prompt_version, p.llm_latency_ms
         FROM recipe_promotions p
         LEFT JOIN members m ON m.id = p.member_id
        WHERE p.recipe_id = ?
        ORDER BY p.promoted_at DESC, p.id DESC`,
    )
    .all(recipeId) as {
    recipe_id: string;
    promoted_at: string;
    member_id: string | null;
    member_name: string | null;
    differences: string;
    cuisine_from: RecipeCuisine | null;
    cuisine_to: RecipeCuisine | null;
    llm_model: string | null;
    llm_prompt_version: string | null;
    llm_latency_ms: number | null;
  }[];

  return rows.map((row) => ({
    recipeId: row.recipe_id,
    promotedAt: row.promoted_at,
    memberId: row.member_id,
    memberName: row.member_name,
    differences: row.differences,
    cuisineFrom: row.cuisine_from,
    cuisineTo: row.cuisine_to,
    llmModel: row.llm_model,
    llmPromptVersion: row.llm_prompt_version,
    llmLatencyMs: row.llm_latency_ms,
  }));
}
