import { useQuery } from '@tanstack/react-query';
import type { MenuPortion, PortionPreviewRequest } from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  DinerPortion,
  DishIngredientPortion,
  DishPortion,
  ExchangeGroup,
  ExchangeItem,
  MenuPortion,
  PortionAgeBand,
  PortionPreviewRequest,
  PortionRecommendedAmount,
  PortionRules,
} from '@dinnerorder/server/types';

/**
 * 草稿菜单的份量（#16）：编辑期即时重算走这个接口。
 *
 * 为什么不由前端自己乘：**年龄必须按服务端时钟现算**（小孩生日当天份量就该变），
 * 前端拿不到注入时钟（那是服务端测试用的「现在」），各算各的就会在跨零点/跨生日时打架。
 * 份量的规则只有服务端一份，前端只负责显示。
 *
 * 每次改动名单/菜品都会换掉 queryKey，所以 TanStack Query 自动重算、自动取消上一次请求
 * （`signal` 一路传到 fetch）。
 */
export function usePortionPreview(diners: string[], dishes: { recipeId: string; keepLeftover: boolean }[]) {
  return useQuery({
    queryKey: ['portion-preview', diners, dishes.map((dish) => [dish.recipeId, dish.keepLeftover])],
    enabled: diners.length > 0 && dishes.length > 0,
    queryFn: async ({ signal }): Promise<MenuPortion> => {
      const payload: PortionPreviewRequest = {
        diners,
        dishes: dishes.map((dish) => ({ recipeId: dish.recipeId, keepLeftover: dish.keepLeftover })),
      };
      const response = await fetch(apiUrl('/portion/preview'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) throw new Error(await readErrorDetail(response));
      return ((await response.json()) as { portion: MenuPortion }).portion;
    },
    // 份量是纯函数（同一份名单/菜单/时刻必然同一结果），但时钟会走：短 staleTime 让回到页面时重算一次
    staleTime: 30_000,
  });
}

/** 服务端的错误体翻成一句能指认对象的话（与 meals 的同口径；份量接口只有这几种错） */
async function readErrorDetail(response: Response): Promise<string> {
  let body: { error?: string; recipeId?: string; memberId?: string; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return `份量没算出来：HTTP ${response.status}`;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '份量的入参不合法';
  if (body.error === 'unknown_recipe') return `菜谱库里没有这一道：${body.recipeId ?? ''}`;
  if (body.error === 'unknown_member') return `家人列表里没有这个人：${body.memberId ?? ''}`;
  return `份量没算出来：HTTP ${response.status}`;
}
