import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  addManualItem,
  AggregateItemNotDeletableError,
  archiveGroceryList,
  archivedGroceryCount,
  deleteManualItem,
  GroceryItemNotFoundError,
  groceryList,
  recalculateGroceryList,
  setGroceryItemChecked,
} from '../domain/grocery.js';
import { todayOf } from '../domain/slots.js';

/**
 * 买菜清单（总纲 §2.7、spec S8）——掌勺者一张单走菜场。
 *
 * 路由形状跟着**动作**走，不跟着资源走：
 *   * `GET /grocery`：读当前这份（没有就 null，服务端不凭空造一张空清单）；
 *   * `POST /grocery/recalculate`：**手动重算**——聚合是重算出来的结果，不是一个可 PUT 的资源；
 *     它是「重算」这个动作本身（原型 v1 的按钮就是这个语义），所以是 POST 无体。
 *   * `POST /grocery/archive`：买完归档（进行中 → 已归档），与重算同族的状态迁移动作。
 *   * `POST /grocery/items` / `PATCH /grocery/items/:id` / `DELETE /grocery/items/:id`：
 *     手工行的增删 + 逐行勾选。
 *
 * 勾选用 `PATCH` 送**显式布尔**而不是 `POST .../toggle`：「买到/没买到」是这一行的状态，
 * 而 toggle 要求两端对「当前是什么」看法一致——手机上多按一下、离线重发一次就会翻反。
 */
const manualItemSchema = z.object({
  /** 掌勺者临时要买的东西（自由文本；不属于任何菜谱） */
  name: z.string().trim().min(1, '手工行得有个名字').max(50, '手工行的名字太长了'),
});

const checkSchema = z.object({
  checked: z.boolean(),
});

export function registerGroceryRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock } = deps;

  api.get('/grocery', (c) =>
    c.json({
      list: groceryList(db, clock),
      // 家庭时区的今天：界面按它把来源标成「今天午餐」而不是裸日期
      today: todayOf(clock),
      archivedCount: archivedGroceryCount(db),
    }),
  );

  // 手动重算（总纲 §2.7）：重新聚合 + 勾选按食材继承 + 手工行保留 + 清过期标记。
  // 只认进行中的清单——归档的清单是封存的历史，重算它等于篡改买完的账。
  api.post('/grocery/recalculate', (c) => {
    const list = recalculateGroceryList(db, clock);
    if (list === null) return c.json({ error: 'no_grocery_list' }, 409);
    return c.json({ list });
  });

  api.post('/grocery/archive', (c) => {
    const list = archiveGroceryList(db, clock);
    if (list === null) return c.json({ error: 'no_grocery_list' }, 409);
    return c.json({ list });
  });

  api.post('/grocery/items', zodValidator('json', manualItemSchema), (c) => {
    const { name } = c.req.valid('json');
    try {
      return c.json({ list: addManualItem(db, clock, name) });
    } catch (error) {
      return groceryError(c, error);
    }
  });

  api.patch('/grocery/items/:id', zodValidator('json', checkSchema), (c) => {
    const id = Number(c.req.param('id'));
    const { checked } = c.req.valid('json');
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'grocery_item_not_found', itemId: c.req.param('id') }, 404);
    try {
      return c.json({ list: setGroceryItemChecked(db, id, checked) });
    } catch (error) {
      return groceryError(c, error);
    }
  });

  api.delete('/grocery/items/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'grocery_item_not_found', itemId: c.req.param('id') }, 404);
    try {
      return c.json({ list: deleteManualItem(db, id) });
    } catch (error) {
      return groceryError(c, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx：界面要能说清「是哪一行、为什么不行」（仓库既有纪律：排除与拒绝
 * 的原因必须看得见），而不是笼统一句失败。
 */
function groceryError(c: Context, error: unknown): Response {
  if (error instanceof GroceryItemNotFoundError) {
    return c.json({ error: 'grocery_item_not_found', itemId: error.itemId }, 404);
  }
  if (error instanceof AggregateItemNotDeletableError) {
    return c.json({ error: 'aggregate_item_not_deletable', itemId: error.itemId }, 400);
  }
  throw error;
}
