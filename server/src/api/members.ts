import type { Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  BirthMonthRequiredError,
  findMember,
  InvalidBirthMonthError,
  listMembers,
  MemberNotFoundError,
  UnknownIngredientError,
  UnknownRecipeError,
  updateMember,
} from '../domain/members.js';

/**
 * 画像编辑入参。三块各自可选：没传的块保持原样，传了的块**整体替换**——
 * 手机上的编辑改完点保存，客户端发的是当前完整清单，不做逐条增删的半程接口
 * （那种接口一多，半份状态就有地方藏）。
 *
 * 爱吃是**混合粒度**（总纲 §2.9）：`{kind:'ingredient'|'recipe', id}`。
 * 用带 kind 的对象而不是裸 id：两张表主键各自独立，光给字符串无法判断该当食材还是当菜。
 */
const loveSchema = z.object({
  kind: z.enum(['ingredient', 'recipe']),
  id: z.string().min(1),
});

const patchSchema = z.object({
  birthMonth: z
    .string()
    // 只收 'YYYY-MM'（线上入口）。领域层 updateMember 也留同口径校验：
    // 它可能被直接调用，不能依赖路由层的把关
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '出生年月必须是 YYYY-MM')
    .nullable()
    .optional(),
  avoid: z.array(z.string().min(1)).optional(),
  loves: z.array(loveSchema).optional(),
});

export function registerMemberRoutes(api: Hono, deps: AppDeps): void {
  api.get('/members', (c) => c.json({ members: listMembers(deps.db) }));

  api.get('/members/:id', (c) => {
    const member = findMember(deps.db, c.req.param('id'));
    if (!member) return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
    return c.json({ member });
  });

  api.patch('/members/:id', zodValidator('json', patchSchema), (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ member: updateMember(deps.db, id, c.req.valid('json')) });
    } catch (error) {
      // 领域错误映射成明确的 4xx：界面要能说清「哪一条没救回来」，而不是笼统失败
      if (error instanceof MemberNotFoundError) return c.json({ error: 'not_found', id }, 404);
      if (error instanceof BirthMonthRequiredError) return c.json({ error: 'birth_month_required', id }, 400);
      if (error instanceof InvalidBirthMonthError) {
        return c.json({ error: 'invalid_birth_month', birthMonth: error.birthMonth }, 400);
      }
      if (error instanceof UnknownIngredientError) {
        return c.json({ error: 'unknown_ingredient', ingredientId: error.ingredientId }, 400);
      }
      if (error instanceof UnknownRecipeError) {
        return c.json({ error: 'unknown_recipe', recipeId: error.recipeId }, 400);
      }
      throw error;
    }
  });
}
