import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Recipe,
  RecipeCreate,
  RecipeEditRecord,
  RecipePatch,
  RecipeStatusActionInput,
} from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  RecipeCreate,
  RecipeEditRecord,
  RecipePatch,
} from '@dinnerorder/server/types';

/**
 * 菜谱库的写操作（issue #30；ADR-0009）：录入 / 修订 / 退役 / 还原。
 *
 * `useMutation` 而不是 `useQuery`：四条都是有副作用的动作。成功后一律
 * `invalidateQueries({ queryKey: ['recipes'] })`——前缀失效会把 `'all'` / `'active'` / `'draft'`
 * 三份缓存一起刷掉（与 `usePromoteRecipe` 同一纪律）：一次写会同时改变三份视图里的同一道菜。
 */
export function useCreateRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecipeCreate): Promise<Recipe> => {
      const response = await fetch(apiUrl('/recipes'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await readWriteError(response));
      return ((await response.json()) as { recipe: Recipe }).recipe;
    },
    onSuccess: () => invalidateRecipes(queryClient),
  });
}

export function usePatchRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ recipeId, input }: { recipeId: string; input: RecipePatch }): Promise<Recipe> => {
      const response = await fetch(apiUrl(`/recipes/${recipeId}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await readWriteError(response));
      return ((await response.json()) as { recipe: Recipe }).recipe;
    },
    onSuccess: (_recipe, variables) => {
      invalidateRecipes(queryClient);
      // 台账跟着刷新：刚写的那一条要出现在「修改历史」里
      queryClient.invalidateQueries({ queryKey: ['recipe-edits', variables.recipeId] });
    },
  });
}

/** 退役 / 还原：两条动词路径共用一个 mutation（入参只差路径） */
export function useRecipeStatusAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      recipeId,
      action,
      input = {},
    }: {
      recipeId: string;
      action: 'retire' | 'restore';
      input?: RecipeStatusActionInput;
    }): Promise<Recipe> => {
      const response = await fetch(apiUrl(`/recipes/${recipeId}/${action}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await readWriteError(response));
      return ((await response.json()) as { recipe: Recipe }).recipe;
    },
    onSuccess: (_recipe, variables) => {
      invalidateRecipes(queryClient);
      queryClient.invalidateQueries({ queryKey: ['recipe-edits', variables.recipeId] });
    },
  });
}

function invalidateRecipes(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ['recipes'] });
  // 菜谱变了，已定的菜单/份量读数跟着变（菜的克数改了份量就该改）
  queryClient.invalidateQueries({ queryKey: ['slots'] });
  queryClient.invalidateQueries({ queryKey: ['portion'] });
}

/**
 * 把服务端的写错误翻成一句人话（每条都指向一个明确的下一步动作）。
 * 错误码与 `server/src/api/recipes.ts` 的 `recipeWriteError` 一一对应。
 */
async function readWriteError(response: Response): Promise<string> {
  let body: { error?: string; status?: string; ingredientId?: string; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return `保存没成功：HTTP ${response.status}`;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'not_found') return '这道菜不在菜谱库里了，刷新一下页面';
  if (body.error === 'unknown_member') return '身份对不上家人列表，刷新一下页面';
  if (body.error === 'unknown_ingredient') return `食材字典里没有这个食材（${body.ingredientId ?? ''}）`;
  if (body.error === 'duplicate_ingredient') return '食材清单里有重复项，同一个食材只能出现一次';
  if (body.error === 'ingredient_grams') return '克数必须大于 0——拿不准就先填个估计值，别留空';
  if (body.error === 'no_changes') return '这次没有改动任何内容';
  if (body.error === 'not_editable') return '退役的菜改不了，先点「还原」';
  if (body.error === 'not_active') return '只有家庭菜谱能退役（草稿本来就不在推荐里）';
  if (body.error === 'not_retired') return '这道菜没有退役，不用还原';
  if (body.error === 'already_retired') return '这道菜已经退役了，刷新一下页面';
  return `保存没成功：HTTP ${response.status}`;
}

/** 某道菜的修订台账（`GET /recipes/:id/edits`）：与转正台账并列、各自独立 */
export function useRecipeEdits(recipeId: string | null) {
  return useQuery({
    queryKey: ['recipe-edits', recipeId],
    queryFn: ({ signal }) => fetchRecipeEdits(recipeId!, signal),
    enabled: recipeId !== null,
    staleTime: 60_000,
  });
}

async function fetchRecipeEdits(recipeId: string, signal: AbortSignal): Promise<RecipeEditRecord[]> {
  const response = await fetch(apiUrl(`/recipes/${recipeId}/edits`), { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`修订台账读取失败：HTTP ${response.status}`);
  return ((await response.json()) as { edits: RecipeEditRecord[] }).edits;
}
