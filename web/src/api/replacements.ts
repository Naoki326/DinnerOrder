import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  SlotWithPortion,
  SwapCandidates,
  SwapCandidatesRequest,
  SwapCandidatesResponse,
} from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002），前端不手抄
export type {
  SwapCandidate,
  SwapCandidates,
  SwapCandidatesRequest,
  SwapExcluded,
  SwapRelaxation,
} from '@dinnerorder/server/types';

/**
 * 换菜候选（总纲 §2.3、spec S2）：给一道菜要 3 个替换选项。
 *
 * `useMutation` 而不是 `useQuery`：候选不是「读取某个资源」，而是「请后端为此刻算一份」
 * （近 7 天吃过什么随时在变、会话排除逐次累积），并且它刻意不落库（与整餐推荐同一取舍）。
 *
 * 「再换一个」= 再打一次并把本会话累积排除的菜（被换掉的 + 已出示过的候选）放进 `exclude`：
 * 会话状态放在客户端（那一轮换菜
 * 只存在于家人的手机上），服务端不建会话表——一个无登录的家庭 app 多一张会话表就得管过期。
 */
export function useCandidates(slotId: string) {
  return useMutation({
    mutationFn: (request: SwapCandidatesRequest) => postCandidates(slotId, request),
  });
}

async function postCandidates(slotId: string, request: SwapCandidatesRequest): Promise<SwapCandidates> {
  const response = await fetch(apiUrl(`/slots/${slotId}/candidates`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const detail = await readSwapError(response);
    throw new Error(detail ?? `换菜失败：HTTP ${response.status}`);
  }
  return ((await response.json()) as SwapCandidatesResponse).candidates;
}

/**
 * 撤销「换一整套」（#18：换一整套可反悔回上一套）。
 *
 * 服务端从事件流推导「上一套」（它是这条 `replace_set` 之前那条事件的快照），
 * 撤销本身也是一条新事件（append-only：历史不删）——所以这里只是「请后端把这一餐退回去」，
 * 前端不做任何本地回滚：本地回滚过的界面与服务端的留痕会对不上。
 */
export function useUndoSet(slotId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SlotWithPortion> => {
      const response = await fetch(apiUrl(`/slots/${slotId}/undo-set`), {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const detail = await readSwapError(response);
        throw new Error(detail ?? `撤销失败：HTTP ${response.status}`);
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

/** 把换菜相关的服务端错误翻成一句人话（每条都指向一个明确的下一步动作） */
async function readSwapError(response: Response): Promise<string | undefined> {
  let body: { error?: string; recipeId?: string; promptVersion?: string; issues?: { message: string }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'slot_passed') return '这一餐已经过了，换不了了';
  if (body.error === 'slot_undecided') return '这一餐还没定，先定下来再换单道';
  if (body.error === 'dish_not_in_menu') return '菜单里已经没有这道菜了，刷新一下页面';
  if (body.error === 'no_candidates') return '这个位子上没有别的菜可换了——换个用餐者名单，或过几天再试';
  if (body.error === 'unknown_member') return '用餐者名单里有不在家人列表里的人，刷新一下页面';
  if (body.error === 'invalid_slot_id') return '这一餐的地址不对';
  if (body.error === 'nothing_to_undo') return '没有可以撤销的换套了';
  if (body.error === 'unknown_prompt_version') return '这份推荐的版本号对不上，刷新页面重来一次';
  return undefined;
}
