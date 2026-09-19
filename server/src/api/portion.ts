import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  convertExchange,
  exchangeTable,
  portionOf,
  portionRules,
  UnknownExchangeItemError,
} from '../domain/portion.js';
import {
  DuplicateDishError,
  EmptyDinersError,
  EmptyDishesError,
  InvalidSlotIdError,
  UnknownMemberError,
  UnknownRecipeError,
} from '../domain/slots.js';

/**
 * 份量引擎的读接口（#16、ADR-0004）：
 *
 * - `GET  /portion/rules`：折算系数表 + 成人锚点 + 各人群推荐量（都是带来源的数据资产）
 * - `GET  /portion/exchange`：WS/T 554 附录 A 生熟/同类互换表
 * - `GET  /portion/exchange/convert?from=&grams=`：一次换算（买菜克数 ↔ 食谱克数）
 * - `POST /portion/preview`：草稿菜单的份量（还没存也要看得见）
 *
 * 为什么 preview 是 POST 而不是把份量塞进 GET 查询串：用餐者可能有四五人、菜单三四道菜，
 * 序列化进 URL 又长又难读；而且**年龄必须按服务端时钟现算**（小孩生日当天份量就该变），
 * 由界面自己算会在跨零点/跨生日时与服务端打架。编辑期的即时重算走这一个接口。
 *
 * 菜单定下来之后份量由 `GET /api/slots/:id` 内嵌返回（`slot.portion`），
 * 界面首屏读菜单时不必再打一次 preview。
 */
const dinersSchema = z.array(z.string().min(1)).min(1, '用餐者名单不能为空');

const dishesSchema = z
  .array(
    z.object({
      recipeId: z.string().min(1),
      keepLeftover: z.boolean().optional(),
    }),
  )
  .min(1, '菜单里至少要有一道菜');

const previewSchema = z.object({
  diners: dinersSchema,
  dishes: dishesSchema,
  /**
   * 正在编辑哪个餐槽（#22）：带上它，编辑器里才能看见留量上浮真的生效了
   * （上浮要问「这一餐有没有被『吃剩的』引用」）。缺省 = 草稿（无引用）。
   */
  slotId: z.string().min(1).optional(),
});

const convertQuerySchema = z.object({
  /** 互换表条目 id（知道条目名时先打 GET /portion/exchange 找 id） */
  from: z.string().min(1),
  grams: z.coerce.number().positive('克数必须大于 0'),
});

export function registerPortionRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock } = deps;

  api.get('/portion/rules', (c) => c.json({ rules: portionRules(db) }));

  api.get('/portion/exchange', (c) => c.json({ groups: exchangeTable(db) }));

  api.get('/portion/exchange/convert', zodValidator('query', convertQuerySchema), (c) => {
    const { from, grams } = c.req.valid('query');
    try {
      return c.json({ conversion: convertExchange(db, from, grams) });
    } catch (error) {
      if (error instanceof UnknownExchangeItemError) {
        return c.json({ error: 'unknown_exchange_item', itemId: error.itemId }, 404);
      }
      throw error;
    }
  });

  api.post('/portion/preview', zodValidator('json', previewSchema), (c) => {
    try {
      const { slotId, ...input } = c.req.valid('json');
      return c.json({ portion: portionOf(db, clock, input, { slotId }) });
    } catch (error) {
      return portionError(c, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx（与 slots 的 bookingError 同口径，各路由各自映射——
 * 依赖同一个领域错误类型，但对外报的字段名跟着本路由的入参走）。
 *
 * 这里的 `invalid_slot_id` 是**必须报**的：`slotId` 说了「我在算哪一餐」，传了一个不是餐槽的
 * id 时只有两种选择——报错，或者当作「无引用」算出一份少乘系数的读数。后者看起来一切正常，
 * 却会让调用方在几条数据之间对不上账。
 */
function portionError(c: Context, error: unknown): Response {
  if (error instanceof InvalidSlotIdError) return c.json({ error: 'invalid_slot_id', id: error.id }, 400);
  if (error instanceof UnknownRecipeError) return c.json({ error: 'unknown_recipe', recipeId: error.recipeId }, 400);
  if (error instanceof UnknownMemberError) return c.json({ error: 'unknown_member', memberId: error.memberId }, 400);
  if (error instanceof EmptyDinersError) return c.json({ error: 'empty_diners' }, 400);
  if (error instanceof EmptyDishesError) return c.json({ error: 'empty_dishes' }, 400);
  if (error instanceof DuplicateDishError) return c.json({ error: 'duplicate_dish', recipeId: error.recipeId }, 400);
  throw error;
}
