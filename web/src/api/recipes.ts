import { useQuery } from '@tanstack/react-query';
import type { Recipe, RecipeStatus } from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  Recipe,
  RecipeCuisine,
  RecipeEffort,
  RecipeKind,
  RecipeSource,
  RecipeStatus,
  TasteTag,
} from '@dinnerorder/server/types';

async function fetchRecipes(status: RecipeStatus | 'all', signal: AbortSignal): Promise<Recipe[]> {
  const response = await fetch(apiUrl('/recipes', { status }), { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`菜谱库读取失败：HTTP ${response.status}`);
  const body = (await response.json()) as { recipes: Recipe[] };
  return body.recipes;
}

/** 定餐选菜器要能看见**全部**菜谱：转正态是默认，但草稿（外部补位的菜）也要能上桌（spec S6） */
export function useRecipes(status: RecipeStatus | 'all' = 'all') {
  return useQuery({
    queryKey: ['recipes', status],
    queryFn: ({ signal }) => fetchRecipes(status, signal),
    staleTime: 60_000,
  });
}
