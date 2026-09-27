import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  coolingDishList,
  deleteFeedback,
  DishNotInSlotError,
  FeedbackNotFoundError,
  FEEDBACK_SUMMARY_DAYS,
  InvalidFeedbackTagError,
  listFeedback,
  mealsToReview,
  reviewCursor,
  REVIEW_DAYS,
  storeFeedback,
  UnknownRecipeError,
  UnknownSlotIdError,
} from '../domain/feedback.js';
import { MemberNotFoundError } from '../domain/members.js';

/**
 * 反馈与餐后回顾（总纲 §2.5；ADR-0005）。
 *
 * 三条路由的形状各有理由：
 *   * `POST /feedback`：一条反馈 = 一次显式动作（点一下赞/踩），重复提交是**改主意**
 *     （UPDATE 同一行，不追加历史）——所以是 POST 而不是 PUT：调用方不需要知道「这一条已经存在吗」，
 *     服务端认（餐槽 × 菜 × 家人）这个身份自己决定插还是改。
 *   * `GET /feedback`：读窗口内的反馈（餐后回顾卡回显「谁说了什么」）与**冷藏中的菜**
 *     （界面要说清「这道为什么没出现」，与换菜候选的忌口排除原因同一纪律）。
 *   * `DELETE /feedback`：撤回（按错了）。判定只有赞/踩两种，再点一下是**改成另一种**；
 *     「什么都不说」是第三种状态，用删除表达最清楚。
 *
 * 反馈归属「当前身份」（总纲 §2.4 无登录）：`memberId` 由界面从当前身份带上来，
 * 服务端不猜——一个没有主的反馈在家庭里毫无意义（「谁觉得太油」是这条记录的全部价值）。
 */
const feedbackSchema = z.object({
  slotId: z.string().min(1, '要指明是哪一餐'),
  recipeId: z.string().min(1, '要指明是哪道菜'),
  memberId: z.string().min(1, '反馈要归属到一位家人（当前身份）'),
  verdict: z.enum(['like', 'dislike']),
  /** 快捷标签（值域封闭，与 domain/feedback.ts 的 FEEDBACK_TAGS 同源）；缺省空数组，不强制 */
  tags: z.array(z.string().min(1)).optional(),
});

const deleteSchema = z.object({
  slotId: z.string().min(1),
  recipeId: z.string().min(1),
  memberId: z.string().min(1),
});

const listQuerySchema = z.object({
  /** 反馈摘要窗口（家规默认 30 天，与推荐管线读的是同一份）；与回顾窗口**分开** */
  days: z.coerce.number().int().min(1).max(365).default(FEEDBACK_SUMMARY_DAYS),
  /**
   * 回顾窗口：不早于今天往前 N 天。不传 = 只给近期（`REVIEW_DAYS`）。
   * 它和 `days` **刻意不是同一个旋钮**：反馈摘要的窗口决定「推荐读到什么」，
   * 撑大它会让推荐被几年前的旧事影响——而回顾只是给人看的。
   */
  reviewDays: z.coerce.number().int().min(1).max(3650).default(REVIEW_DAYS),
  /**
   * 「看更早的」游标：只返回早于这个餐槽的餐（上一批的最后一餐的 slotId）。
   * 用游标而不是页码：翻页期间另一端在写新反馈/新餐槽时，页码会漏掉或重复一条。
   */
  before: z.string().min(1).optional(),
});

export function registerFeedbackRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock } = deps;
  /**
   * 探测「还有没有更早的」时额外往前的天数。
   * * 小 = 首屏空的家人可能被告知“到底了”而其实还差一点；
   * * 大 = 每次 GET 多扫几个餐槽（回顾页是低频页面，代价可忽略）。
   * 30 天足以覆盖「上次开火是上个月」这种常见情形。
   */
  const PROBE_DAYS = 30;

  api.post('/feedback', zodValidator('json', feedbackSchema), (c) => {
    try {
      const body = c.req.valid('json');
      const feedback = storeFeedback(db, clock, body);
      // 点踩是否真的把菜点进了冷藏期：由冷藏期判定现算（家规 14 天、任一本餐用餐者触发即可），
      // 界面上「14 天内不再推这道」这句提示才有依据——而不是前端照着自己刚发的踩就说
      const cooling = coolingDishList(db, clock).find((dish) => dish.recipeId === body.recipeId);
      return c.json({ feedback, cooling: cooling ?? null });
    } catch (error) {
      return feedbackError(c, error);
    }
  });

  api.get('/feedback', zodValidator('query', listQuerySchema), (c) => {
    const { days, reviewDays, before } = c.req.valid('query');
    const meals = mealsToReview(db, clock, reviewDays, before);
    const oldest = meals[meals.length - 1];
    // 下一页的游标由**服务端下发**（`reviewCursor`），前端不自己从 `meals` 里猜：
    //   * 首屏为空时（这几天没吃过、更早的吃过）没有「最后一餐」可当游标，前端就算不出来
    //     ——而那种情形恰恰只剩「看更早的」一条路可走；
    //   * 窗口边界（`reviewDays`）本来就是服务端的概念。
    const cursor = reviewCursor(clock, reviewDays, oldest?.slotId);
    return c.json({
      feedback: listFeedback(db, clock, days),
      cooling: coolingDishList(db, clock),
      meals,
      // 还有没有更早的：拿游标再探一次。服务端算比前端猜「満页就是还有」准：
      // 満页但恰好到底时，前端会多给一个按下去什么都不发生的按钮（“看得见的空动作”）。
      //
      // 探测要用**比本页更宽的窗口**：本页游标退到窗口下界时（首屏为空那种情形），
      // 沿本页的 `reviewDays` 再查一遍是自相矛盾的（“早于 5/30 且不早于 5/30”永远为空），
      // 于是首屏空的家人会得到一个「再往前就没有了」的谎话。
      hasEarlier: mealsToReview(db, clock, reviewDays + PROBE_DAYS, cursor).length > 0,
      olderThan: cursor,
    });
  });

  api.delete('/feedback', zodValidator('json', deleteSchema), (c) => {
    try {
      deleteFeedback(db, c.req.valid('json'));
      return c.json({ ok: true });
    } catch (error) {
      return feedbackError(c, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx：反馈失败要能指认（这餐的菜单里没有这道菜 / 不是合法标签 / 没有这条反馈），
 * 每条家人都有明确的下一步动作；笼统一句失败会把「我传错菜 id 了」和「这条已经撤回了」混成一种。
 */
function feedbackError(c: Context, error: unknown): Response {
  if (error instanceof UnknownSlotIdError) return c.json({ error: 'invalid_slot_id', id: error.slotId }, 400);
  if (error instanceof UnknownRecipeError) return c.json({ error: 'unknown_recipe', recipeId: error.recipeId }, 400);
  if (error instanceof MemberNotFoundError) return c.json({ error: 'unknown_member', memberId: error.id }, 400);
  if (error instanceof DishNotInSlotError) {
    return c.json({ error: 'dish_not_in_slot', slotId: error.slotId, recipeId: error.recipeId }, 400);
  }
  if (error instanceof InvalidFeedbackTagError) return c.json({ error: 'invalid_tag', tag: error.tag }, 400);
  if (error instanceof FeedbackNotFoundError) {
    return c.json({ error: 'feedback_not_found', slotId: error.slotId, recipeId: error.recipeId }, 404);
  }
  throw error;
}
