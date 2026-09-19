import { useQuery } from '@tanstack/react-query';
import type { Ingredient } from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type { Ingredient };

async function fetchIngredients(query: string, signal: AbortSignal): Promise<Ingredient[]> {
  const response = await fetch(apiUrl('/ingredients', { q: query }), {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`食材字典读取失败：HTTP ${response.status}`);
  const body = (await response.json()) as { ingredients: Ingredient[] };
  return body.ingredients;
}

/** 画像编辑挑食材用：`q` 同时匹配规范名与别名（「西红柿」也能找到「番茄」）。
 * 空搜索不发请求——全家人的卡片各挂一份，不加这道门就是首屏白拉八遍全字典。 */
export function useIngredients(query: string) {
  const keyword = query.trim();
  return useQuery({
    queryKey: ['ingredients', keyword],
    queryFn: ({ signal }) => fetchIngredients(keyword, signal),
    enabled: keyword !== '',
    staleTime: 60_000,
  });
}
