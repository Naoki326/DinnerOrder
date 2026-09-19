import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PromotionInput, PromotionResponse, PromotionResult } from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type { PromotionInput, PromotionRecord, PromotionResult } from '@dinnerorder/server/types';

/**
 * 转正（总纲 §2.8、spec S6；ADR-0006）：餐后回顾里掌勺者对一道**外部补位菜**（草稿）
 * 点「转正」，可口述差异，LLM 在原菜谱上改写成家里版本，状态 draft → active
 * → 进家庭库 + 推荐池。
 *
 * `useMutation` 而不是 `useQuery`：它是一次有副作用的动作（会调 LLM、会改库），
 * 与 `useSaveFeedback` 同一形状。菜谱本身读回来走 `useRecipes`。
 */
export function usePromoteRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ recipeId, input }: { recipeId: string; input: PromotionInput }): Promise<PromotionResult> => {
      const response = await fetch(apiUrl(`/recipes/${recipeId}/promotion`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const detail = await readPromotionError(response);
        throw new Error(detail ?? `转正没成功：HTTP ${response.status}`);
      }
      return ((await response.json()) as PromotionResponse).promotion;
    },
    onSuccess: () => {
      // 状态从 draft 翻到 active：菜谱列表（选菜器/回顾页的转正表单）与餐槽都要重取。
      // `['recipes']` 的前缀失效会把 'all' / 'draft' / 'active' 三份缓存一起刷掉——
      // 正是这里要的：转正同时改变三份视图里的同一道菜。
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      queryClient.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}

/**
 * 把服务端的转正错误翻成一句人话（每条都指向一个明确的下一步动作）。
 * 错误码与 `server/src/api/recipes.ts` 的 `promotionError` 一一对应。
 */
async function readPromotionError(response: Response): Promise<string | undefined> {
  let body: { error?: string; status?: string; notes?: string[]; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'not_found') return '这道菜不在菜谱库里了，刷新一下页面';
  if (body.error === 'not_draft') {
    return body.status === 'active' ? '这道菜已经转正过了' : '退役的菜不能再转正';
  }
  if (body.error === 'recipe_not_served') return '这道菜还没上过桌——先把它做一顿，吃过之后再来转正';
  if (body.error === 'unknown_member') return '身份对不上家人列表，刷新一下页面';
  if (body.error === 'rewrite_failed') {
    return `LLM 没能把这道菜改写成家里版本，菜谱没有改动（可以再试一次）：${body.notes?.[0] ?? ''}`;
  }
  return undefined;
}
