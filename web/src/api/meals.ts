import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RecentDish,
  SlotBooking,
  SlotCancelResponse,
  SlotResponse,
  SlotsResponse,
  SlotWithPortion,
} from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  DinerRef,
  MealEvent,
  MealEventType,
  MealKind,
  MealSlot,
  MealSlotStatus,
  Menu,
  MenuDish,
  RecentDish,
  SlotBooking,
  SlotResponse,
  SlotsResponse,
  SlotWithPortion,
} from '@dinnerorder/server/types';

/** 主界面要的「下一餐优先」列表：今天起 n 天，已过截止时刻的餐次服务端已经滤掉 */
export function useSlots(days = 3) {
  return useQuery({
    queryKey: ['slots', days],
    queryFn: async ({ signal }): Promise<SlotsResponse> => {
      const response = await fetch(apiUrl('/slots', { days }), { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`餐槽读取失败：HTTP ${response.status}`);
      return (await response.json()) as SlotsResponse;
    },
    staleTime: 10_000,
  });
}

/** 单个餐槽 + 它的留痕（编辑器页与「这一餐怎么定下来的」都用它） */
export function useSlot(slotId: string | undefined) {
  return useQuery({
    queryKey: ['slot', slotId],
    enabled: Boolean(slotId),
    queryFn: async ({ signal }): Promise<SlotResponse> => {
      const response = await fetch(apiUrl(`/slots/${slotId}`), { signal, headers: { accept: 'application/json' } });
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(detail ?? `这一餐读取失败：HTTP ${response.status}`);
      }
      return (await response.json()) as SlotResponse;
    },
  });
}

/** 「最近吃过」：去重窗口内的菜（走事件流；#17 的规则引擎会用它做软避让） */
export function useRecentDishes(days = 7) {
  return useQuery({
    queryKey: ['recent-dishes', days],
    queryFn: async ({ signal }): Promise<RecentDish[]> => {
      const response = await fetch(apiUrl('/history/recent-dishes', { days }), {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`最近吃过读取失败：HTTP ${response.status}`);
      return ((await response.json()) as { dishes: RecentDish[] }).dishes;
    },
    staleTime: 30_000,
  });
}

async function putSlot(slotId: string, booking: SlotBooking): Promise<SlotWithPortion> {
  const response = await fetch(apiUrl(`/slots/${slotId}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(booking),
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `保存失败：HTTP ${response.status}`);
  }
  return ((await response.json()) as { slot: SlotWithPortion }).slot;
}

async function deleteSlot(slotId: string): Promise<SlotCancelResponse> {
  const response = await fetch(apiUrl(`/slots/${slotId}`), { method: 'DELETE', headers: { accept: 'application/json' } });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `取消失败：HTTP ${response.status}`);
  }
  // 取消被「吃剩的」引用的那一餐时，服务端会把引用方一起退回未定（#22）；
  // 把被退回的槽 id 带出来，界面才能说清「晚餐已经跟着取消了」
  return (await response.json()) as SlotCancelResponse;
}

/** 定餐 = 改餐：同一个编辑器、同一个提交（总纲 §2.1） */
export function useBookSlot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slotId, booking }: { slotId: string; booking: SlotBooking }) => putSlot(slotId, booking),
    onSuccess: (_slot, { slotId }) => {
      queryClient.invalidateQueries({ queryKey: ['slots'] });
      queryClient.invalidateQueries({ queryKey: ['slot', slotId] });
      // 菜单改了，「最近吃过」的去重窗口数据也可能变（取消/改餐）
      queryClient.invalidateQueries({ queryKey: ['recent-dishes'] });
    },
  });
}

export function useCancelSlot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slotId: string) => deleteSlot(slotId),
    onSuccess: (result, slotId) => {
      queryClient.invalidateQueries({ queryKey: ['slots'] });
      queryClient.invalidateQueries({ queryKey: ['slot', slotId] });
      // 联动画回的引用方（#22）也要失效：它的缓存里还留着已定的菜单
      for (const released of result.released) {
        queryClient.invalidateQueries({ queryKey: ['slot', released] });
      }
      queryClient.invalidateQueries({ queryKey: ['recent-dishes'] });
    },
  });
}

/**
 * 把一餐预定成「吃剩的」（#22）：带上被引用那一餐的槽 id，菜品为空（吃什么从被引用那一餐推导）。
 * 与普通定餐走同一个 `PUT`（同一个编辑器、同一条留痕），只是形态不同。
 */
export function useBookLeftover() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      slotId,
      leftoverOf,
      diners,
      cook,
    }: {
      slotId: string;
      leftoverOf: string;
      diners: string[];
      /** 掌勺者（本票）：与普通定餐同一条整份提交；不传 = 按家里的习惯缺省 */
      cook?: string | null;
    }) =>
      putSlot(slotId, {
        diners,
        dishes: [],
        leftoverOf,
        ...(cook === undefined ? {} : { cook }),
      }),
    onSuccess: (_slot, { slotId, leftoverOf }) => {
      queryClient.invalidateQueries({ queryKey: ['slots'] });
      queryClient.invalidateQueries({ queryKey: ['slot', slotId] });
      // 被引用那一餐的上浮跟着变了，它的份量也要重算
      queryClient.invalidateQueries({ queryKey: ['slot', leftoverOf] });
      queryClient.invalidateQueries({ queryKey: ['recent-dishes'] });
    },
  });
}

/** 把服务端的错误体翻成一句能指认对象的话（与 members 的画像编辑同口径） */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  let body: { error?: string; recipeId?: string; memberId?: string; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'unknown_recipe') return `菜谱库里没有这一道：${body.recipeId ?? ''}`;
  if (body.error === 'unknown_member') return `家人列表里没有这个人：${body.memberId ?? ''}`;
  if (body.error === 'recipe_retired') return '这道菜已经退役了，要吃先转正';
  if (body.error === 'duplicate_dish') return '同一道菜不能在一餐里出现两次';
  if (body.error === 'empty_diners') return '至少要点一位用餐者';
  if (body.error === 'empty_dishes') return '菜单里至少要留一道菜';
  if (body.error === 'slot_passed') return '这一餐已经过了，定不了了';
  if (body.error === 'not_decided') return '这一餐本来就没定，不用取消';
  // 「吃剩的」（#22）的三种拒绝：各自说清是哪一步不对
  if (body.error === 'invalid_leftover_reference') return '「吃剩的」只能引用同一日的午餐，而且那一餐得先定下来';
  if (body.error === 'nothing_to_reheat') return '中午那餐没有标记留量的菜，没有可吃剩的';
  if (body.error === 'leftover_with_dishes') return '「吃剩的」那一餐不带自己的菜单';
  if (body.error === 'not_found') return '这一餐不存在，刷新一下页面';
  return undefined;
}
