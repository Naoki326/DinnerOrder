import type { Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  BirthMonthRequiredError,
  createMember,
  deleteMember,
  EMPTY_MEMBER_EMOJI_MESSAGE,
  EMPTY_MEMBER_NAME_MESSAGE,
  EmptyMemberEmojiError,
  EmptyMemberNameError,
  findMember,
  INVALID_BIRTH_MONTH_MESSAGE,
  InvalidBirthMonthError,
  InvalidGenderError,
  listMembers,
  MemberNotFoundError,
  MISSING_BIRTH_MONTH_MESSAGE,
  MissingBirthMonthError,
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
  // 名字/头像：与新增时同一口径（trim 后非空）。`trim()` 放在形状层，
  // 否则 `'   '` 这种「只有空白」会在 min(1) 眼里合法，而它在界面上就是个空名字。
  name: z.string().trim().min(1, EMPTY_MEMBER_NAME_MESSAGE).optional(),
  emoji: z.string().trim().min(1, EMPTY_MEMBER_EMOJI_MESSAGE).optional(),
  // 性别只在新增时问过一次，也得改得回来：6–17 岁小孩的份量系数按性别差约 14%
  // （WS/T 554 表 1）。录错了一直偏，而删了重建会丢掉忌口/爱吃/餐史归属。
  gender: z.enum(['male', 'female']).optional(),
  birthMonth: z
    .string()
    // 只收 'YYYY-MM'（线上入口）。领域层 updateMember 也留同口径校验：
    // 它可能被直接调用，不能依赖路由层的把关
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, INVALID_BIRTH_MONTH_MESSAGE)
    .nullable()
    .optional(),
  avoid: z.array(z.string().min(1)).optional(),
  loves: z.array(loveSchema).optional(),
  // 掌勺者标记（本票起可改）：语义是「家里通常谁做菜」，是缺省值——
  // 每一餐的掌勺者在菜单上（`SlotBooking.cook`）。允许并列多位，不强制单例。
  isCook: z.boolean().optional(),
});

/**
 * 新增家人的入参（本票）。名字/头像/大人小孩/性别都必填，小孩另需出生年月。
 *
 * 形状层能拦的就在这里拦，并把错误**指认到字段**：家人手机上填错一栏时要能看见「哪一栏不对」，
 * 所以一律走 `{error:'invalid_request', issues:[{path,message}]}`（仓库统一形状，见 validation.ts）。
 * `.trim()` 在形状层就把首尾空白去掉：只有空白串（`'   '`）在 zod 的 `min(1)` 眼里是合法字符串，
 * 但它在界面上就是一个**空名字**——服务端的非空校验要在这一层真的生效。
 */
const createSchema = z
  .object({
    name: z.string().trim().min(1, EMPTY_MEMBER_NAME_MESSAGE),
    emoji: z.string().trim().min(1, EMPTY_MEMBER_EMOJI_MESSAGE),
    kind: z.enum(['adult', 'child']),
    // 大人也要必填性别（见 wire-types 的 MemberCreate 注释：6–17 岁小孩的系数按性别相差 14%）
    gender: z.enum(['male', 'female']),
    // 小孩必填由下面的 superRefine 管；大人可以留空，也可以录（画像字段本身对大人有意义）
    birthMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, INVALID_BIRTH_MONTH_MESSAGE)
      .nullable()
      .optional(),
  })
  .superRefine((input, ctx) => {
    // 小孩没有出生年月 = 份量分带没有依据（也是 001 的 CHECK）。在表单层就说清，
    // 不让它掉到数据库那条没法翻译成人话的约束报错上。
    if (input.kind === 'child' && (input.birthMonth ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['birthMonth'],
        message: MISSING_BIRTH_MONTH_MESSAGE,
      });
    }
  });

export function registerMemberRoutes(api: Hono, deps: AppDeps): void {
  api.get('/members', (c) => c.json({ members: listMembers(deps.db) }));

  api.get('/members/:id', (c) => {
    const member = findMember(deps.db, c.req.param('id'));
    if (!member) return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
    return c.json({ member });
  });

  /**
   * 新增家人（本票）。201 + 落库后的完整画像（`avoid`/`loves` 为空数组、`isCook` 为 false）：
   * 调用方拿到它就能直接上屏，不必再打一次 `GET /members/:id`。
   */
  api.post('/members', zodValidator('json', createSchema), (c) => {
    try {
      return c.json({ member: createMember(deps.db, c.req.valid('json'), deps.clock) }, 201);
    } catch (error) {
      // 形状层已经拦掉绝大多数情况（包括「小孩缺出生年月」），这里剩下的是**绕过 zod 的调用方**
      // 与领域约束的兜底：错误体形状与形状层保持一致，前端不必为它们再写一套分支。
      if (error instanceof EmptyMemberNameError) {
        return c.json({ error: 'invalid_request', issues: [{ path: 'name', message: EMPTY_MEMBER_NAME_MESSAGE }] }, 400);
      }
      if (error instanceof EmptyMemberEmojiError) {
        return c.json({ error: 'invalid_request', issues: [{ path: 'emoji', message: EMPTY_MEMBER_EMOJI_MESSAGE }] }, 400);
      }
      if (error instanceof MissingBirthMonthError) {
        return c.json(
          { error: 'invalid_request', issues: [{ path: 'birthMonth', message: MISSING_BIRTH_MONTH_MESSAGE }] },
          400,
        );
      }
      if (error instanceof InvalidBirthMonthError) {
        return c.json({
          error: 'invalid_request',
          issues: [{ path: 'birthMonth', message: INVALID_BIRTH_MONTH_MESSAGE }],
        }, 400);
      }
      throw error;
    }
  });

  /**
   * 删家人 = **软删除**（本票的决议，理由见 010 迁移）：打一个 `deleted_at`，行与历史都留着。
   * 删除的是「从此不再参与」——从家人列表消失、不再进用餐者名单、忌口/爱吃不再生效；
   * 已吃过的餐、已说过的反馈一行不改。
   *
   * 响应回一份被删家人的画像（`ok: true` + `member`）：调用方据此确认删掉的到底是哪一位；
   * 删完再想查他就查不到了——`GET /members/:id` 对已删的家人返回 404（与「从列表消失」同一口径）。
   */
  api.delete('/members/:id', (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ ok: true, member: deleteMember(deps.db, id, deps.clock) });
    } catch (error) {
      if (error instanceof MemberNotFoundError) return c.json({ error: 'not_found', id }, 404);
      throw error;
    }
  });

  api.patch('/members/:id', zodValidator('json', patchSchema), (c) => {
    const id = c.req.param('id');
    try {
      return c.json({ member: updateMember(deps.db, id, c.req.valid('json')) });
    } catch (error) {
      // 领域错误映射成明确的 4xx：界面要能说清「哪一条没救回来」，而不是笼统失败
      if (error instanceof MemberNotFoundError) return c.json({ error: 'not_found', id }, 404);
      // 名字/头像的空值：与新增走**同一形状**（invalid_request + issues 指认字段），
      // 界面因此不必为「新增」与「修改」写两套提示分支
      if (error instanceof EmptyMemberNameError) {
        return c.json({ error: 'invalid_request', issues: [{ path: 'name', message: EMPTY_MEMBER_NAME_MESSAGE }] }, 400);
      }
      if (error instanceof EmptyMemberEmojiError) {
        return c.json({ error: 'invalid_request', issues: [{ path: 'emoji', message: EMPTY_MEMBER_EMOJI_MESSAGE }] }, 400);
      }
      if (error instanceof InvalidGenderError) {
        return c.json(
          { error: 'invalid_request', issues: [{ path: 'gender', message: '性别只能是 male 或 female' }] },
          400,
        );
      }
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
