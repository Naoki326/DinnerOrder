import { useQuery } from '@tanstack/react-query';
import type { MenuNutrition, RecipeDetail } from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  DishNutrition,
  DishNutritionIngredient,
  IngredientNutrition,
  MenuNutrition,
  RecipeDetail,
} from '@dinnerorder/server/types';

/**
 * 一餐的营养合计（本票）：按需拉取——只有用户点了「📊 营养」才请求。
 *
 * 为什么不内嵌进 `slot.portion`：营养是**看完就走**的展示量，而菜单读取（`/api/slots`）
 * 是所有界面路径都要打的；挂上去会让每次打开编辑器都多算一份谁也没要的营养。
 * 服务端把「缺数据的食材」也一并报出来（`missingIngredients`），界面必须把它说出来。
 */
export function useSlotNutrition(slotId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['slot-nutrition', slotId],
    enabled: Boolean(slotId) && enabled,
    queryFn: async ({ signal }): Promise<MenuNutrition | null> => {
      const response = await fetch(apiUrl(`/slots/${slotId}/nutrition`), {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(detail ?? `营养没算出来：HTTP ${response.status}`);
      }
      return ((await response.json()) as { nutrition: MenuNutrition | null }).nutrition;
    },
    // 份量/营养是纯函数（同一菜单同一时刻必然同一结果），但时钟会走：短 staleTime 让重开面板重算
    staleTime: 30_000,
  });
}

/** 一道菜的食谱（做法步骤 + 食材清单，本票）：点了「食谱」才请求 */
export function useRecipeDetail(recipeId: string | undefined) {
  return useQuery({
    queryKey: ['recipe-detail', recipeId],
    enabled: Boolean(recipeId),
    queryFn: async ({ signal }): Promise<RecipeDetail> => {
      const response = await fetch(apiUrl(`/recipes/${recipeId}/recipe`), {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`这道菜的做法读取失败：HTTP ${response.status}`);
      return ((await response.json()) as { recipe: RecipeDetail }).recipe;
    },
    // 菜谱是静态数据（改做法要走迁移），长 staleTime 足够
    staleTime: 5 * 60_000,
  });
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  let body: { error?: string; id?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_slot_id') return '这一餐的地址不对，读不到营养';
  return undefined;
}
