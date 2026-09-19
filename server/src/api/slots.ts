import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  bookSlot,
  cancelSlot,
  DuplicateDishError,
  EmptyDinersError,
  EmptyDishesError,
  foldSlot,
  InvalidSlotIdError,
  listSlotEvents,
  listUpcomingSlots,
  parseSlotId,
  recentDishes,
  SlotNotDecidedError,
  SlotPassedError,
  todayOf,
  UnknownMemberError,
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
    .min(1, '菜单里至少要有一道菜'),
  source: z.enum(['manual', 'recommendation']).optional(),
});

const listQuerySchema = z.object({
  /** 往后看几天（含今天）；主界面给今天起的三天两卡列 */
  days: z.coerce.number().int().min(1).max(14).default(3),
});

const recentQuerySchema = z.object({
  /** 去重窗口（家规默认 7 天，总纲 §4） */
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export function registerSlotRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock } = deps;

  api.get('/slots', zodValidator('query', listQuerySchema), (c) => {
    const { days } = c.req.valid('query');
    return c.json({ today: todayOf(clock), slots: listUpcomingSlots(db, clock, days) });
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
    return c.json({ slot, history: listSlotEvents(db, id) });
  });

  api.put('/slots/:id', zodValidator('json', bookingSchema), (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ slot: bookSlot(db, clock, id, c.req.valid('json')) });
    } catch (error) {
      return bookingError(c, id, error);
    }
  });

  api.delete('/slots/:id', (c) => {
    const id = c.req.param('id');
    try {
      cancelSlot(db, clock, id);
      return c.json({ ok: true });
    } catch (error) {
      return bookingError(c, id, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx：界面要能说清「是哪一条没救回来」（哪个人不在家人列表、哪道菜不在菜谱库），
 * 而不是笼统一句失败。
 */
function bookingError(c: Context, id: string, error: unknown): Response {
  if (error instanceof SlotPassedError) return c.json({ error: 'slot_passed', id }, 400);
  if (error instanceof SlotNotDecidedError) return c.json({ error: 'not_decided', id }, 404);
  if (error instanceof InvalidSlotIdError) return c.json({ error: 'invalid_slot_id', id }, 400);
  if (error instanceof UnknownRecipeError) return c.json({ error: 'unknown_recipe', recipeId: error.recipeId }, 400);
  if (error instanceof RecipeRetiredError) return c.json({ error: 'recipe_retired', recipeId: error.recipeId }, 400);
  if (error instanceof UnknownMemberError) return c.json({ error: 'unknown_member', memberId: error.memberId }, 400);
  if (error instanceof EmptyDinersError) return c.json({ error: 'empty_diners' }, 400);
  if (error instanceof EmptyDishesError) return c.json({ error: 'empty_dishes' }, 400);
  if (error instanceof DuplicateDishError) return c.json({ error: 'duplicate_dish', recipeId: error.recipeId }, 400);
  throw error;
}
