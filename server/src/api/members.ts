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
  updateMember,
} from '../domain/members.js';

/**
 * 画像编辑入参。三块各自可选：没传的块保持原样，传了的块**整体替换**——
 * 手机上的编辑改完点保存，客户端发的是当前完整清单，不做逐条增删的半程接口
 * （那种接口一多，半份状态就有地方藏）。
 *
 * 爱吃的**菜粒度**（`recipeIds`）等 #15 建菜谱表后加进来：本票不发明一个没人能填的字段。
 */
const patchSchema = z.object({
  birthMonth: z
    .string()
    // 只收 'YYYY-MM'（线上入口）。领域层 updateMember 也留同口径校验：
    // 它可能被直接调用，不能依赖路由层的把关
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '出生年月必须是 YYYY-MM')
    .nullable()
    .optional(),
  avoid: z.array(z.string().min(1)).optional(),
  loves: z.array(z.string().min(1)).optional(),
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
      throw error;
    }
  });
}
