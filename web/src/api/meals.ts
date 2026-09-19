import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MealSlot, RecentDish, SlotBooking, SlotResponse, SlotsResponse } from '@dinnerorder/server/types';
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

async function putSlot(slotId: string, booking: SlotBooking): Promise<MealSlot> {
  const response = await fetch(apiUrl(`/slots/${slotId}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(booking),
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `保存失败：HTTP ${response.status}`);
  }
  return ((await response.json()) as { slot: MealSlot }).slot;
}

async function deleteSlot(slotId: string): Promise<void> {
  const response = await fetch(apiUrl(`/slots/${slotId}`), { method: 'DELETE', headers: { accept: 'application/json' } });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `取消失败：HTTP ${response.status}`);
  }
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
    onSuccess: (_result, slotId) => {
      queryClient.invalidateQueries({ queryKey: ['slots'] });
      queryClient.invalidateQueries({ queryKey: ['slot', slotId] });
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
  if (body.error === 'not_found') return '这一餐不存在，刷新一下页面';
  return undefined;
}
