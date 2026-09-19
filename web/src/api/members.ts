import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MemberCreate,
  MemberCreateResponse,
  MemberDeleteResponse,
  MemberProfile as Member,
  ProfilePatch,
} from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type {
  LoveEntry,
  LoveTarget,
  MemberCreate,
  MemberProfile as Member,
  MemberProfile,
  ProfileEntry,
  ProfilePatch,
} from '@dinnerorder/server/types';

async function fetchMembers(signal: AbortSignal): Promise<Member[]> {
  const response = await fetch(apiUrl('/members'), { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`家人列表读取失败：HTTP ${response.status}`);
  const body = (await response.json()) as { members: Member[] };
  return body.members;
}

async function patchMember(id: string, patch: ProfilePatch): Promise<Member> {
  const response = await fetch(apiUrl(`/members/${id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    // 400 带着具体的错因（哪一条食材不在字典里 / 小孩不能清出生年月）：
    // 把服务端说的那一条原样报出来，别把「哪一条没救回来」压成一句笼统失败
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `画像保存失败：HTTP ${response.status}`);
  }
  const body = (await response.json()) as { member: Member };
  return body.member;
}

/**
 * 把服务端的错误体翻成一句能指认对象的话；认不出的形状就交回 undefined（调用方走笼统文案）。
 *
 * `invalid_request` 的 `issues[0].message` 已经是中文人话（`validation.ts` 把 zod 的消息原样带出），
 * 所以这里直接用它——「哪一栏不对」由服务端说，前端不重写一遍文案再等它源移。
 */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  let body: {
    error?: string;
    ingredientId?: string;
    recipeId?: string;
    birthMonth?: string;
    issues?: { path: string; message: string }[];
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return undefined;
  }
  if (body.error === 'invalid_request') return body.issues?.[0]?.message ?? '格式不对';
  if (body.error === 'unknown_ingredient') return `食材字典里没有这一条：${body.ingredientId ?? ''}`;
  if (body.error === 'unknown_recipe') return `菜谱库里没有这一道：${body.recipeId ?? ''}`;
  if (body.error === 'birth_month_required') return '小孩必须保留出生年月（份量按年龄分带折算）';
  // 格式错误经 zod 先拦（走上面的 invalid_request），这一支只在绕过 zod 的入口才可能命中
  if (body.error === 'invalid_birth_month') return `出生年月必须是 YYYY-MM：${body.birthMonth ?? ''}`;
  if (body.error === 'not_found') return '这位家人不在了，刷新一下页面';
  return undefined;
}

/**
 * 新增家人（本票）：一级表单一次提交，落库后立即出现在列表里（可切换为当前身份、可进用餐者名单）。
 * 忌口/爱吃不上表——新增后在同一张卡上用现有的画像编辑入口加（`useUpdateMember`）。
 */
async function createMember(input: MemberCreate): Promise<Member> {
  const response = await fetch(apiUrl('/members'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    // 400 带着具体错因（哪一栏没填 / 小孩缺出生年月）：把服务端说的那一条原样报出来
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `新增家人失败：HTTP ${response.status}`);
  }
  return ((await response.json()) as MemberCreateResponse).member;
}

/**
 * 删除家人（本票）= 服务端的**软删除**：从列表消失、不再进用餐者名单，历史（含反馈）一行不丢。
 * 返回被删家人的画像：界面据此在卡片上原地确认删掉的是谁。
 */
async function deleteMember(id: string): Promise<Member> {
  const response = await fetch(apiUrl(`/members/${id}`), {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail ?? `删除失败：HTTP ${response.status}`);
  }
  return ((await response.json()) as MemberDeleteResponse).member;
}

export function useMembers() {
  return useQuery({
    queryKey: ['members'],
    queryFn: ({ signal }) => fetchMembers(signal),
    staleTime: 30_000,
  });
}

export function useUpdateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ProfilePatch }) => patchMember(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members'] }),
  });
}

export function useCreateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MemberCreate) => createMember(input),
    // 列表是新增的唯一落地点（「新增后立即可用」就靠这一次 invalidate）：
    // 家人页/切换器/定餐编辑器的用餐者名单都从同一个 `['members']` 查询取数。
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members'] }),
  });
}

export function useDeleteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMember(id),
    // 删掉的家人可能正是**当前身份**：invalidate 让 `useIdentity` 拿到不带他的新列表，
    // 那里的 effect 自动回退到掌勺者（identity.tsx 已有，本票不改它）。
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members'] }),
  });
}
