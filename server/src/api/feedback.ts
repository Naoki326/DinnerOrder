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
  /** 窗口（家规默认 30 天，与反馈摘要同一个窗口）；界面按餐卡回显时用不了这么大，够用即可 */
  days: z.coerce.number().int().min(1).max(365).default(FEEDBACK_SUMMARY_DAYS),
});

export function registerFeedbackRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock } = deps;

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
    const { days } = c.req.valid('query');
    return c.json({ feedback: listFeedback(db, clock, days), cooling: coolingDishList(db, clock), meals: mealsToReview(db, clock) });
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
