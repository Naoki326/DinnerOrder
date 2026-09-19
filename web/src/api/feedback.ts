import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DishFeedback,
  FamilyRules,
  FamilyRulesResponse,
  FeedbackDeleteInput,
  FeedbackInput,
  FeedbackListResponse,
  FeedbackResponse,
} from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  CoolingDish,
  DishFeedback,
  FamilyRules,
  FeedbackInput,
  FeedbackListResponse,
  FeedbackTag,
  FeedbackVerdict,
  ReviewMeal,
} from '@dinnerorder/server/types';

/**
 * 反馈与餐后回顾（总纲 §2.5；ADR-0005）。
 *
 * 一次 `GET /feedback` 拿三样东西：窗口内的反馈（谁说了什么）、**正在冷藏的菜**
 * （「这道为什么没出现」的解释）与**已上桌的餐**（饭后餐卡的列表）。
 * 三者同源——都取决于「这段时间家里人说过什么」，分开取只会在三处各算一遍窗口。
 */
export function useFeedback() {
  return useQuery({
    queryKey: ['feedback'],
    queryFn: async ({ signal }): Promise<FeedbackListResponse> => {
      const response = await fetch(apiUrl('/feedback'), { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`反馈读取失败：HTTP ${response.status}`);
      return (await response.json()) as FeedbackListResponse;
    },
    staleTime: 10_000,
  });
}

/** 家规（单例配置）：界面用它解释「冷藏期多久」（不把 14 天硬编码在文案里） */
export function useFamilyRules() {
  return useQuery({
    queryKey: ['family-rules'],
    queryFn: async ({ signal }): Promise<FamilyRules> => {
      const response = await fetch(apiUrl('/family-rules'), { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`家规读取失败：HTTP ${response.status}`);
      return ((await response.json()) as FamilyRulesResponse).rules;
    },
    staleTime: 60_000,
  });
}

/**
 * 写一条反馈（同一人同一餐同一道菜再点一下 = **改主意**，服务端 UPDATE 那一行）。
 *
 * `useMutation` 而不是 `useQuery`：它是「说一句话」的动作，不是读取资源；
 * 反馈本身读回来走 `useFeedback`。
 */
export function useSaveFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: FeedbackInput): Promise<FeedbackResponse> => {
      const response = await fetch(apiUrl('/feedback'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const detail = await readFeedbackError(response);
        throw new Error(detail ?? `反馈没存上：HTTP ${response.status}`);
      }
      return (await response.json()) as FeedbackResponse;
    },
    onSuccess: () => {
      // 反馈一变，冷藏期与摘要都可能变——三处（回顾页/菜单卡/推荐）都从这里失效重取
      queryClient.invalidateQueries({ queryKey: ['feedback'] });
      queryClient.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}

/** 撤回一条反馈（按错了/不想说了）：判定只有赞/踩两种，再点一下是改成另一种，「什么都不说」用删除表达 */
export function useDeleteFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: FeedbackDeleteInput): Promise<void> => {
      const response = await fetch(apiUrl('/feedback'), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const detail = await readFeedbackError(response);
        throw new Error(detail ?? `撤回没成功：HTTP ${response.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback'] });
      queryClient.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}

/** 某道菜在这份反馈列表里的记录（当前身份对这一餐这道菜的看法） */
export function feedbackOf(
  feedback: DishFeedback[] | undefined,
  slotId: string,
  recipeId: string,
  memberId: string | undefined,
): DishFeedback | undefined {
  if (!feedback || !memberId) return undefined;
  return feedback.find(
    (item) => item.slotId === slotId && item.recipeId === recipeId && item.memberId === memberId,
  );
}


/** 把服务端的反馈错误翻成一句人话（每条都指向一个明确的下一步动作） */
async function readFeedbackError(response: Response): Promise<string | undefined> {
  let body: { error?: string; tag?: string; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'invalid_tag') return `不是可选的快捷标签：${body.tag ?? ''}`;
  if (body.error === 'dish_not_in_slot') return '这一餐的菜单里已经没这道菜了，刷新一下页面';
  if (body.error === 'unknown_member') return '身份对不上家人列表，刷新一下页面';
  if (body.error === 'feedback_not_found') return '这条反馈已经不在了，刷新一下页面';
  return undefined;
}
