import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import { NoCandidatesError, recommendMeal } from '../domain/recommendation.js';
import { InvalidSlotIdError, SlotPassedError, UnknownMemberError } from '../domain/slots.js';

/**
 * 整餐推荐（总纲 §2.2 显式触发、§4 管线；ADR-0001）。
 *
 * **推荐是 GET 语义但用 POST**：它不带请求体也不改状态（不落库、不缓存），但要把「这餐谁吃」
 * 放进请求——那份名单可能四五个人，塞进查询串又长又难读；而且推荐是**懒计算**（每次现算，
 * 因为「近 7 天吃过什么」随时在变），不是可以放心缓存的资源读取。用 POST + 无副作用
 * 是这里的取舍，路由注释里说明，避免后来者以为它可以随便重放缓存。
 *
 * 接受推荐不走这里：复用 `PUT /api/slots/:id`（`source:'recommendation'` + 回传 `llm` 元数据），
 * 也就是「定餐 = 换菜，同一个编辑器」（总纲 §2.1）——推荐只是把编辑器预填好。
 */
const recommendationSchema = z.object({
  /** 用餐者（member id）；不传 = 全体家人（与定餐编辑器的默认同一口径） */
  diners: z.array(z.string().min(1)).min(1, '用餐者名单不能为空').optional(),
});

export function registerRecommendationRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock, llm } = deps;

  api.post('/slots/:id/recommendation', zodValidator('json', recommendationSchema), async (c) => {
    const id = c.req.param('id');
    try {
      const body = c.req.valid('json');
      const recommendation = await recommendMeal(db, clock, llm, id, { diners: body.diners });
      return c.json({ recommendation });
    } catch (error) {
      return recommendationError(c, id, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx：推荐失败的原因要能指认（这餐过了 / 名单里有人不存在 / 池子空了），
 * 而不是笼统一句失败——后两种家人都有明确的下一步动作。
 */
function recommendationError(c: Context, id: string, error: unknown): Response {
  if (error instanceof SlotPassedError) return c.json({ error: 'slot_passed', id }, 400);
  if (error instanceof InvalidSlotIdError) return c.json({ error: 'invalid_slot_id', id }, 400);
  if (error instanceof UnknownMemberError) return c.json({ error: 'unknown_member', memberId: error.memberId }, 400);
  if (error instanceof NoCandidatesError) return c.json({ error: 'no_candidates', id }, 409);
  throw error;
}
