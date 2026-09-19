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
 *
 * `ready`：调用方还没拿到「谁还在家人列表里」时先别算。已定菜单的名单是**当时的快照**，
 * 可能含已删的家人——份量引擎对显式名单里的他们报 `unknown_member`。名单没到位时算一次，
 * 只会得到一个注定 400 的请求，然后在家人到位后重算（本票修复的正是这个空窗：
 * 编辑器要把名单里的已删家人剔给份量引擎看，而「谁已删」要先知道家人在册的那一份）。
 */
export function usePortionPreview(
  diners: string[],
  dishes: { recipeId: string; keepLeftover: boolean }[],
  /**
   * 正在编辑哪个餐槽（#22）：留量上浮要问「这一餐有没有被『吃剩的』引用」。
   * 不传 = 草稿（新定的一餐还没有引用），上浮恒不生效——界面据此决定显不显示倍数。
   */
  slotId?: string,
  options: { ready?: boolean } = {},
) {
  const ready = options.ready ?? true;
  return useQuery({
    queryKey: ['portion-preview', diners, dishes.map((dish) => [dish.recipeId, dish.keepLeftover]), slotId],
    enabled: ready && diners.length > 0 && dishes.length > 0,
    queryFn: async ({ signal }): Promise<MenuPortion> => {
      const payload: PortionPreviewRequest = {
        diners,
        dishes: dishes.map((dish) => ({ recipeId: dish.recipeId, keepLeftover: dish.keepLeftover })),
        ...(slotId === undefined ? {} : { slotId }),
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
  if (body.error === 'invalid_slot_id') return '这一餐的地址不对（算不出该不该上浮）';
  return `份量没算出来：HTTP ${response.status}`;
}
