import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroceryItem, GroceryList, GroceryListResponse } from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  GroceryItem,
  GroceryItemKind,
  GroceryItemSource,
  GroceryList,
  GroceryListResponse,
  GroceryListStatus,
  GroceryStaleReason,
} from '@dinnerorder/server/types';

/**
 * 买菜清单（总纲 §2.7、spec S8）。
 *
 * 读一次 `GET /grocery` 拿齐四样：进行中的清单（含逐行勾选与过期标记）、家庭时区的今天
 * （界面按它把来源标成「今天午餐」而不是裸日期）、已归档清单数（「买完归档」要看得见结果）。
 * `list` 为 null 是正常状态（没定过餐、或刚归档完），不是错误。
 */
export function useGrocery() {
  return useQuery({
    queryKey: ['grocery'],
    queryFn: async ({ signal }): Promise<GroceryListResponse> => {
      const response = await fetch(apiUrl('/grocery'), { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`买菜清单读取失败：HTTP ${response.status}`);
      return (await response.json()) as GroceryListResponse;
    },
    staleTime: 10_000,
  });
}

/**
 * 清单的变化走同一个 mutation 形状：服务端每次都回**整份清单**，界面直接换上，
 * 不自己按操作猜本地状态（勾选、重算继承这些语义都只有服务端知道）。
 */
async function send(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<GroceryList> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: body === undefined
      ? { accept: 'application/json' }
      : { 'content-type': 'application/json', accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = await readGroceryError(response);
    throw new Error(detail ?? `操作没成功：HTTP ${response.status}`);
  }
  return ((await response.json()) as { list: GroceryList }).list;
}

function useGroceryMutation<TInput>(
  mutationFn: (input: TInput) => Promise<GroceryList>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (list) => {
      // 服务端回的是整份清单，直接写进缓存：条数、勾选、过期标记一次到位，
      // 不额外打一次 GET（也就不会出现「界面已更新但服务端还在旧值」的中间态）
      queryClient.setQueryData(['grocery'], (current: GroceryListResponse | undefined) => ({
        list,
        today: current?.today ?? '',
        archivedCount: current?.archivedCount ?? 0,
      }));
    },
  });
}

/** 手动重算（总纲 §2.7）：重新聚合 + 勾选按食材继承 + 手工行保留 + 清过期标记 */
export function useRecalculateGrocery() {
  return useGroceryMutation(() => send('POST', '/grocery/recalculate'));
}

/**
 * 买完归档：进行中 → 已归档。
 *
 * 这条**重取**而不是把响应塞进缓存：归档之后这份清单不再「进行中」，界面要回到空态，
 * 「已归档 N 份」也要重新读。服务端 GET 在没有新菜单时不会再物化一张同内容的清单
 * （按聚合指纹判定），所以这次重取是稳定的。
 */
export function useArchiveGrocery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => send('POST', '/grocery/archive'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['grocery'] }),
  });
}

/** 加一条手工行（自由文本，不属于任何菜谱，重算时保留） */
export function useAddManualItem() {
  return useGroceryMutation((name: string) => send('POST', '/grocery/items', { name }));
}

/** 逐行勾选（送到手/还没买到）。显式布尔，不做 toggle——两端各翻一次会把状态翻丢 */
export function useCheckItem() {
  return useGroceryMutation(({ itemId, checked }: { itemId: number; checked: boolean }) =>
    send('PATCH', `/grocery/items/${itemId}`, { checked }),
  );
}

/** 删一条手工行（聚合行删不了：它由已定餐聚合而来，改餐后重算自然更新） */
export function useDeleteManualItem() {
  return useGroceryMutation((itemId: number) => send('DELETE', `/grocery/items/${itemId}`));
}

/**
 * 按分类分组（原型 v1 的分类分组）：聚合行按 `category` 聚，手工行独立一张卡
 * （总纲 §2.7 的两种行在界面上也是两处）。
 *
 * 分组顺序按**首次出现**的顺序（服务端已经排好：荤 → 水产 → 蔬菜 → 主食 → 豆制品 → 其他），
 * 前端不再自己排一遍——排列纪律只有服务端一处。
 */
export function groupByCategory(items: GroceryItem[]): { category: string; items: GroceryItem[] }[] {
  const groups: { category: string; items: GroceryItem[] }[] = [];
  for (const item of items) {
    if (item.kind !== 'aggregate') continue;
    const category = item.category ?? '其他';
    const existing = groups.find((group) => group.category === category);
    if (existing) existing.items.push(item);
    else groups.push({ category, items: [item] });
  }
  return groups;
}

/** 手工行（不属于任何菜谱，重算时保留）：界面上的第二张卡 */
export function manualItems(items: GroceryItem[]): GroceryItem[] {
  return items.filter((item) => item.kind === 'manual');
}

/**
 * 把服务端的错误体翻成一句能指认对象的话。
 *
 * ⚠️ 这是全仓第 4 份同形函数（`meals.ts` / `members.ts` / `portion.ts` 各一份），
 * **有意保留、不提取**（#23 评审判断）：四份的交集只有 `invalid_request` 与 `issues`，
 * 其余每一项都是「错误体字段随路由而变」——grocery 的 `itemId` 与 `aggregate_item_not_deletable`
 * 在另外三个路由里根本不存在，提取一个共用 helper 只会把四条路由的错误词表搅在一起，
 * 且改一处会波及四个界面。与台账「`portionError` 与 `bookingError` 的映射重复（有意保留）」
 * 同一口径；四条路各自新增错误码时只改自己那一份。
 */
async function readGroceryError(response: Response): Promise<string | undefined> {
  let body: { error?: string; itemId?: number; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'no_grocery_list') return '现在没有进行中的买菜清单，刷新一下页面';
  if (body.error === 'grocery_item_not_found') return '这一行已经不在这份清单里了，刷新一下页面';
  if (body.error === 'aggregate_item_not_deletable') return '聚合行删不掉——改餐之后重算，它自己就更新了';
  return undefined;
}
