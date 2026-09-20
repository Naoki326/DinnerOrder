import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  MealRecommendation,
  RecommendationRequest,
  RecommendationResponse,
  SlotBooking,
  SlotWithPortion,
} from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002），前端不手抄
export type {
  MealRecommendation,
  RecommendedDish,
  RecommendationFormat,
  RecommendationLlmMeta,
  RecommendationRequest,
  RecommendationStructure,
  RecipeOrigin,
} from '@dinnerorder/server/types';

/**
 * 「给我推荐」：显式触发（总纲 §2.2），**不做自动生成**。
 *
 * 推荐不落库、也不缓存（总纲 §4）：每次点都是现算（「近 7 天吃过什么」随时在变），
 * 拿到的那一份只存在于这一次编辑会话里——用户点「一键接受」才会变成菜单。
 * 所以这里用 `useMutation` 而不是 `useQuery`：它不是「读取某个资源」，
 * 而是「请后端为此刻算一份」。
 */
export function useRecommendation(slotId: string) {
  return useMutation({
    mutationFn: (request: RecommendationRequest) => postRecommendation(slotId, request),
  });
}

async function postRecommendation(slotId: string, request: RecommendationRequest): Promise<MealRecommendation> {
  const response = await fetch(apiUrl(`/slots/${slotId}/recommendation`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const detail = await readRecommendationError(response);
    throw new Error(detail ?? `推荐失败：HTTP ${response.status}`);
  }
  return ((await response.json()) as RecommendationResponse).recommendation;
}

/**
 * 一键接受：复用定餐那条路（总纲 §2.1「定餐 = 换菜，同一个编辑器」），
 * 只是把来源标成 recommendation 并把 LLM 元数据一起回传（留痕要能回答「为什么推这道」）。
 */
export function useAcceptRecommendation(slotId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      booking,
      recommendation,
    }: {
      booking: { diners: string[]; dishes: string[]; cook?: string | null };
      recommendation: MealRecommendation;
    }): Promise<SlotWithPortion> => {
      const payload: SlotBooking = {
        diners: booking.diners,
        dishes: booking.dishes.map((recipeId) => ({ recipeId })),
        // 掌勺者（本票）：接受推荐是「整份菜单一次性提交」，所以带上当前这一餐的掌勺者
        // （`undefined` = 按家里的习惯缺省；已定餐槽由调用方传当时那位，不被悄悄改掉）
        ...(booking.cook === undefined ? {} : { cook: booking.cook }),
        source: 'recommendation',
        llm: {
          model: recommendation.llm.model,
          promptVersion: recommendation.llm.promptVersion,
          latencyMs: recommendation.llm.latencyMs,
          degraded: recommendation.llm.degraded,
        },
      };
      const response = await fetch(apiUrl(`/slots/${slotId}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        if (response.status === 400) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          if (body.error === 'slot_passed') throw new Error('这一餐已经过了，定不了了');
        }
        throw new Error(`保存失败：HTTP ${response.status}`);
      }
      return ((await response.json()) as { slot: SlotWithPortion }).slot;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slots'] });
      queryClient.invalidateQueries({ queryKey: ['slot', slotId] });
      queryClient.invalidateQueries({ queryKey: ['recent-dishes'] });
    },
  });
}

/** 把服务端的推荐错误翻成一句人话（推荐特有的两条：池子空了、这餐过了） */
async function readRecommendationError(response: Response): Promise<string | undefined> {
  let body: { error?: string; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'no_candidates') return '按这餐的忌口和最近吃过的菜，挑不出可选的菜了——换个用餐者名单试试';
  if (body.error === 'slot_passed') return '这一餐已经过了，推不了了';
  if (body.error === 'unknown_member') return '用餐者名单里有不在家人列表里的人，刷新一下页面';
  if (body.error === 'invalid_slot_id') return '这一餐的地址不对';
  return undefined;
}
