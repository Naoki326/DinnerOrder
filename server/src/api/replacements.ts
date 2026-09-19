import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  DishNotInMenuError,
  findCandidates,
  NoCandidatesError,
  SlotUndecidedError,
} from '../domain/replacement.js';
import { InvalidSlotIdError, SlotPassedError, UnknownMemberError } from '../domain/slots.js';

/**
 * 换菜候选（总纲 §2.3、§4；spec S2）。
 *
 * 与整餐推荐同一个理由用 POST 而不用 GET：不带请求体就放不下「这次换哪道菜、这餐谁吃、
 * 之前出示过哪些候选」，而且候选是**懒计算**（近 7 天吃过什么随时在变、会话排除逐次累积），
 * 不是可以放心缓存的资源读取。路由无副作用（不落库、不缓存）。
 *
 * 一次请求 = 一次候选；「再换一个」就是再打一次、并把本会话累积排除的菜（被换掉的 + 已出示过的候选，
 * spec §2.3）回传进 `exclude`：
 * 会话状态放在**客户端**（那一轮换菜只存在于家人的手机构思里），服务端不建会话——
 * 一个无登录的家庭 app 多出一张「换菜会话表」，就得管过期与清理，而它换来的只是省一个字段。
 *
 * 接受候选不走这里：仍然是 `PUT /api/slots/:id`（整份菜单一次提交、source='manual'），
 * 也就是「定餐 = 换菜，同一个编辑器」（总纲 §2.1）。
 */
const candidatesSchema = z.object({
  /** 要换掉的那道菜；必须在当前菜单（或客户端带上来的草稿菜单）里 */
  replacing: z.string().min(1, '要指明换掉哪一道菜'),
  diners: z.array(z.string().min(1)).min(1, '用餐者名单不能为空').optional(),
  /** 客户端带上来的草稿菜单（编辑器里还没保存的那份）；不传 = 用服务端已定菜单快照 */
  dishes: z.array(z.string().min(1)).min(1, '草稿菜单至少要有一道菜').optional(),
  /** 本会话累积排除的菜（被换掉的 + 已出示过的候选；「再换一个」累积回传，软排除） */
  exclude: z.array(z.string().min(1)).optional(),
});

/** 换菜请求的 body 里只放「换哪道菜 + 谁吃 + 排除谁」，路径里是餐槽 */
export function registerReplacementRoutes(api: Hono, deps: AppDeps): void {
  const { db, clock, llm } = deps;

  api.post('/slots/:id/candidates', zodValidator('json', candidatesSchema), async (c) => {
    const id = c.req.param('id');
    try {
      const body = c.req.valid('json');
      const candidates = await findCandidates(db, clock, llm, id, body.replacing, {
        diners: body.diners,
        dishes: body.dishes,
        exclude: body.exclude,
      });
      return c.json({ candidates });
    } catch (error) {
      return candidateError(c, id, error);
    }
  });
}

/**
 * 领域错误 → 明确的 4xx：换菜失败的原因要能指认（这餐过了 / 没定 / 菜单里没这道菜 / 没得换），
 * 后三种家人都有明确的下一步动作；笼统一句失败会把「我传错菜 id 了」和「真的没得换」混成一种。
 */
function candidateError(c: Context, id: string, error: unknown): Response {
  if (error instanceof SlotPassedError) return c.json({ error: 'slot_passed', id }, 400);
  if (error instanceof InvalidSlotIdError) return c.json({ error: 'invalid_slot_id', id }, 400);
  if (error instanceof UnknownMemberError) return c.json({ error: 'unknown_member', memberId: error.memberId }, 400);
  if (error instanceof SlotUndecidedError) return c.json({ error: 'slot_undecided', id }, 409);
  if (error instanceof DishNotInMenuError) {
    return c.json({ error: 'dish_not_in_menu', recipeId: error.recipeId, id }, 400);
  }
  if (error instanceof NoCandidatesError) return c.json({ error: 'no_candidates', recipeId: error.recipeId }, 409);
  throw error;
}
