import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import type { MealSlot, SlotWithPortion } from '../wire-types.js';
import { markGroceryStale } from '../domain/grocery.js';
import { portionOf } from '../domain/portion.js';
import {
  bookSlot,
  cancelSlot,
  DuplicateDishError,
  EmptyDinersError,
  EmptyDishesError,
  foldSlot,
  InvalidLeftoverReferenceError,
  InvalidSlotIdError,
  LeftoverWithDishesError,
  listSlotEvents,
  listUpcomingSlots,
  LlmMetaWithoutRecommendationError,
  NothingToReheatError,
  NothingToUndoError,
  parseSlotId,
  recentDishes,
  SlotNotDecidedError,
  SlotPassedError,
  todayOf,
  undoSet,
  UnknownMemberError,
  UnknownPromptVersionError,
  UnknownRecipeError,
  RecipeRetiredError,
} from '../domain/slots.js';

/** 定餐 = 改餐（总纲 §2.1）：同一个编辑器、同一份入参，服务端按当前状态决定记「预定」还是「改餐」事件 */
const bookingSchema = z.object({
  diners: z.array(z.string().min(1)).min(1, '用餐者名单不能为空'),
  dishes: z
    .array(
      z.object({
        recipeId: z.string().min(1),
        keepLeftover: z.boolean().optional(),
      }),
    )
    // 「吃剩的」那一餐自带菜单必须为空，所以「至少一道」不能在这里拦（那是普通形态的规矩）；
    // 两种形态的取舍由领域层判定，它才知道这一条请求是哪种。
    .default([]),
  /** 「吃剩的」引用（#22）：填同日午餐的槽 id；`superRefine` 把「引用 ⟺ 不带菜单」说清 */
  leftoverOf: z.string().min(1).optional(),
  source: z.enum(['manual', 'recommendation']).optional(),
  /** 接受推荐时回传的 LLM 元数据（形状见 wire-types；服务端只用它留痕，不参与判定） */
  llm: z
    .object({
      model: z.string().min(1),
      // 只校验形状；版本号是否真属于这个来源由领域层校验（promptVersionFor /
      // PROMPT_VERSIONS_BY_SOURCE，见 server/src/llm/prompt.ts）
      promptVersion: z.string().min(1),
      latencyMs: z.number().int().min(0),
      degraded: z.boolean(),
    })
    .optional(),
}).superRefine((booking, ctx) => {
  // 普通定餐没有菜、与「吃剩的」还带了菜，都是「这一餐吃什么」说不清的情况。
  // 在形状层就把话说满，两条错误各自指认字段（领域层再拦一道，防直接调域的调用方）。
  if (booking.leftoverOf === undefined && booking.dishes.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['dishes'], message: '菜单里至少要有一道菜' });
  }
  if (booking.leftoverOf !== undefined && booking.dishes.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['dishes'], message: '「吃剩的」那一餐不带菜单（吃的是被引用那一餐多做的那几道）' });
  }
});

const listQuerySchema = z.object({
  /** 往后看几天（含今天）；主界面给今天起的三天两卡列 */
  days: z.coerce.number().int().min(1).max(14).default(3),
});

const recentQuerySchema = z.object({
  /** 去重窗口（家规默认 7 天，总纲 §4） */
  days: z.coerce.number().int().min(1).max(90).default(7),
});

/**
 * 组装带份量的餐槽。份量**不落库、每次现算**（年龄随时钟走：小孩生日当天的份量就该变），
 * 未定就没有菜单、也就没有份量。
 *
 * 名单里的用餐者是**当时的快照**：家人后来被删不改写历史，所以查不到的人按成人份算
 * （`assumeAdult`）而不是让整张卡读取失败——为了一个已经删掉的家人把那一餐的份量
 * 全部废掉，代价与收益完全不对等。
 */
function withPortion(db: Db, clock: Clock, slot: MealSlot): SlotWithPortion {
  return {
    ...slot,
    portion: slot.menu
      ? portionOf(
          db,
          clock,
          { diners: slot.menu.diners.map((diner) => diner.memberId), dishes: slot.menu.dishes },
          // 带上餐槽 id：留量上浮要问「这一餐有没有生效中的『吃剩的』引用」（#22）
          { missingMembers: 'assumeAdult', slotId: slot.id },
        )
      : null,
  };
}

export function registerSlotRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock } = deps;

  api.get('/slots', zodValidator('query', listQuerySchema), (c) => {
    const { days } = c.req.valid('query');
    try {
      return c.json({
        today: todayOf(clock),
        slots: listUpcomingSlots(db, clock, days).map((slot) => withPortion(db, clock, slot)),
      });
    } catch (error) {
      // 存量脏数据（手改库 / 旧版本留下的空名单菜单）会让份量算不出来。
      // 这里必须转成 JSON 错误：直接抛会得到 HTML 500，前端 parse 时报的是「JSON 语法错」
      // 这种与真因无关的错，排查时先把人带偏。
      return bookingError(c, undefined, error);
    }
  });

  // 「最近吃过」（总纲 §3 决议 3：直接查事件流）。路径不放在 /slots/:id 下：
  // 那会让 :id 同时兼职「具体餐槽」与「历史」两个含义，接口语义反而变糊。
  api.get('/history/recent-dishes', zodValidator('query', recentQuerySchema), (c) => {
    const { days } = c.req.valid('query');
    return c.json({ dishes: recentDishes(db, clock, days) });
  });

  api.get('/slots/:id', (c) => {
    const id = c.req.param('id');
    const parsed = parseSlotId(id);
    if (!parsed) return c.json({ error: 'invalid_slot_id', id }, 400);
    const slot = foldSlot(db, clock, parsed.date, parsed.meal);
    try {
      return c.json({ slot: withPortion(db, clock, slot), history: listSlotEvents(db, id) });
    } catch (error) {
      return bookingError(c, id, error);
    }
  });

  api.put('/slots/:id', zodValidator('json', bookingSchema), (c) => {
    const id = c.req.param('id');
    try {
      // 改餐 → 买菜清单标记过期（总纲 §2.7）。
      // 只对**菜单真的变了**的提交标过期（拿留痕条数判）：`bookSlot` 对内容完全相同的提交
      // 不追事件（防手机双击写两条同样的留痕），那种提交不该把清单标过期——否则界面上会冒出
      // 一个「菜单变了」但菜单其实没变的警告。
      //
      // 「改餐」与「标过期」在**同一个事务**里（#23 评审 ⑤-2）：两条写语句各自自动提交时，
      // 中间有个极小的窗口（进程在同一时刻被杀），会留下「菜单已变、清单未过期」的静默不一致
      // ——而这件事正是本清单最不能静默的地方。领域层 `bookSlot` 自己的事务在外层事务里
      // 自动降级成 SAVEPOINT（better-sqlite3 的 `db.inTransaction` 分支），不会重复 BEGIN。
      const apply = db.transaction((): MealSlot => {
        const eventsBefore = listSlotEvents(db, id).length;
        const booked = bookSlot(db, clock, id, c.req.valid('json'));
        if (listSlotEvents(db, id).length > eventsBefore) markGroceryStale(db, id, 'menu_changed');
        return booked;
      });
      const slot = apply();
      return c.json({ slot: withPortion(db, clock, slot) });
    } catch (error) {
      return bookingError(c, id, error);
    }
  });

  api.delete('/slots/:id', (c) => {
    const id = c.req.param('id');
    try {
      // 联动（#22、总纲 §3 决议 4）：取消被「吃剩的」引用的那一餐时，引用方餐槽自动退回未定。
      // 退回的槽 id 一并下发（界面据此提示「晚餐已经跟着取消了」），而不是让前端自己再查一次。
      // 取消同样与「标过期」同事务（理由见上面 PUT 那段）。
      const apply = db.transaction((): string[] => {
        const released = cancelSlot(db, clock, id);
        // 取消也是改餐：清单同样过期（「取消了」——要买的东西少了一份）
        markGroceryStale(db, id, 'cancelled');
        return released;
      });
      const released = apply();
      return c.json({ ok: true, released });
    } catch (error) {
      return bookingError(c, id, error);
    }
  });

  /**
   * 撤销换一整套（#18）：把这一餐恢复成 "换一整套" 之前那一套。
   *
   * 用 POST 而不是 PUT：它不改菜单的**内容**而是把餐槽退回上一个状态，语义上是「执行一个动作」
   * （与 `DELETE /slots/:id` 的取消同族）；而且没有请求体，正好省掉「为什么空体还要 PUT」的解释。
   * 成功返回整个 slot（与 PUT 同一形状），界面可直接用它刷新。
   */
  api.post('/slots/:id/undo-set', (c) => {
    const id = c.req.param('id');
    try {
      // 撤销与「标过期」同事务（理由见上面 PUT 那段）。
      const apply = db.transaction((): MealSlot => {
        const undone = undoSet(db, clock, id);
        // 撒销也是一次菜单变化：清单同样过期（总纲 §2.7 的「改餐」包含它）
        markGroceryStale(db, id, 'set_undone');
        return undone;
      });
      const slot = apply();
      return c.json({ slot: withPortion(db, clock, slot) });
    } catch (error) {
      return bookingError(c, id, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx：界面要能说清「是哪一条没救回来」（哪个人不在家人列表、哪道菜不在菜谱库），
 * 而不是笼统一句失败。
 */
function bookingError(c: Context, id: string | undefined, error: unknown): Response {
  if (error instanceof SlotPassedError) return c.json({ error: 'slot_passed', id }, 400);
  if (error instanceof SlotNotDecidedError) return c.json({ error: 'not_decided', id }, 404);
  if (error instanceof InvalidSlotIdError) return c.json({ error: 'invalid_slot_id', id }, 400);
  if (error instanceof UnknownRecipeError) return c.json({ error: 'unknown_recipe', recipeId: error.recipeId }, 400);
  if (error instanceof RecipeRetiredError) return c.json({ error: 'recipe_retired', recipeId: error.recipeId }, 400);
  if (error instanceof UnknownMemberError) return c.json({ error: 'unknown_member', memberId: error.memberId }, 400);
  if (error instanceof EmptyDinersError) return c.json({ error: 'empty_diners', id }, 400);
  if (error instanceof EmptyDishesError) return c.json({ error: 'empty_dishes', id }, 400);
  if (error instanceof DuplicateDishError) return c.json({ error: 'duplicate_dish', recipeId: error.recipeId }, 400);
  if (error instanceof LlmMetaWithoutRecommendationError) return c.json({ error: 'llm_meta_without_recommendation', id }, 400);
  if (error instanceof UnknownPromptVersionError) {
    return c.json({ error: 'unknown_prompt_version', promptVersion: error.promptVersion }, 400);
  }
  if (error instanceof NothingToUndoError) return c.json({ error: 'nothing_to_undo', id }, 409);
  // 「吃剩的」（#22）的三种拒绝：各自指认得着对象，界面才能说清是哪一步不对
  if (error instanceof InvalidLeftoverReferenceError) {
    return c.json({ error: 'invalid_leftover_reference', id, referencedId: error.referencedId }, 400);
  }
  if (error instanceof NothingToReheatError) {
    return c.json({ error: 'nothing_to_reheat', id, referencedId: error.referencedId }, 400);
  }
  if (error instanceof LeftoverWithDishesError) return c.json({ error: 'leftover_with_dishes', id }, 400);
  throw error;
}
