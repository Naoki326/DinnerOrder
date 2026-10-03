import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Ingredient,
  IngredientConflict,
  IngredientCreate,
  IngredientCreateResponse,
  IngredientDeleteResponse,
  IngredientEditListResponse,
  IngredientEditRecord,
  IngredientPatch,
  IngredientPatchResponse,
  IngredientReferenceCount,
  IngredientReferencesResponse,
} from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」），前端不手抄
export type { Ingredient, IngredientEditRecord, IngredientPatch, IngredientReferenceCount };

async function fetchIngredients(query: string, signal: AbortSignal): Promise<Ingredient[]> {
  const response = await fetch(apiUrl('/ingredients', { q: query }), {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`食材字典读取失败：HTTP ${response.status}`);
  const body = (await response.json()) as { ingredients: Ingredient[] };
  return body.ingredients;
}

/** 画像编辑挑食材用：`q` 同时匹配规范名与别名（「西红柿」也能找到「番茄」）。
 * 空搜索不发请求——全家人的卡片各挂一份，不加这道门就是首屏白拉八遍全字典。 */
export function useIngredients(query: string) {
  const keyword = query.trim();
  return useQuery({
    queryKey: ['ingredients', keyword],
    queryFn: ({ signal }) => fetchIngredients(keyword, signal),
    enabled: keyword !== '',
    staleTime: 60_000,
  });
}

/**
 * 字典页要的是**整张表**（不受搜索词约束），所以另开一条不带 `q` 的查询。
 * 与 `useIngredients` 共用 key 前缀 `['ingredients']`——一次录入/删除后前缀失效会把两份都刷掉。
 */
export function useAllIngredients() {
  return useQuery({
    queryKey: ['ingredients', ''],
    queryFn: ({ signal }) => fetchIngredients('', signal),
    staleTime: 60_000,
  });
}

/**
 * 字典写操作的错误：**带上服务端的结构化信息**，界面才能给出下一步动作
 * （撞名 → 「用这条」；有引用 → 说出被谁用着）。
 *
 * 与 `recipe-library.ts` 的 `readWriteError` 把一切压成一句人话不同：这里的两类失败
 * 都要求界面**拿对象做判断**（不是只显示一句话），所以保留 `code`/`conflict`/`references`。
 */
export class IngredientWriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly conflict?: IngredientConflict,
    readonly references?: IngredientReferenceCount[],
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IngredientWriteError';
  }
}

/** 读服务端的写错误体，翻成 `IngredientWriteError`（错误码与 `api/ingredients.ts` 一一对应） */
async function readWriteError(response: Response): Promise<IngredientWriteError> {
  let body: {
    error?: string;
    conflict?: IngredientConflict;
    references?: IngredientReferenceCount[];
    issues?: { message: string }[];
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return new IngredientWriteError('http_error', `保存没成功：HTTP ${response.status}`, undefined, undefined, response.status);
  }
  if (body.error === 'invalid_request') {
    return new IngredientWriteError('invalid_request', body.issues?.[0]?.message ?? '格式不对', undefined, undefined, response.status);
  }
  if (body.error === 'ingredient_conflict' && body.conflict) {
    return new IngredientWriteError(
      'ingredient_conflict',
      `「${body.conflict.name}」已经在字典里了`,
      body.conflict,
      undefined,
      response.status,
    );
  }
  if (body.error === 'unknown_contains_target') {
    return new IngredientWriteError('unknown_contains_target', '「含」的目标不在字典里，刷新一下页面', undefined, undefined, response.status);
  }
  if (body.error === 'self_contains') {
    return new IngredientWriteError('self_contains', '「含」的目标不能是它自己', undefined, undefined, response.status);
  }
  if (body.error === 'no_changes') {
    return new IngredientWriteError('no_changes', '这次提交没有任何改动', undefined, undefined, response.status);
  }
  if (body.error === 'unknown_member') {
    return new IngredientWriteError('unknown_member', '身份对不上家人列表，刷新一下页面', undefined, undefined, response.status);
  }
  if (body.error === 'ingredient_referenced') {
    return new IngredientWriteError('ingredient_referenced', '这条食材还有人用着，删不掉', undefined, body.references, response.status);
  }
  if (body.error === 'not_found') {
    return new IngredientWriteError('not_found', '这条食材已经不在字典里了，刷新一下页面', undefined, undefined, response.status);
  }
  return new IngredientWriteError('http_error', `保存没成功：HTTP ${response.status}`, undefined, undefined, response.status);
}

/** 录入一条新食材（只有一个必填项：规范名）。成功返回落库后的完整食材。 */
export function useCreateIngredient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: IngredientCreate): Promise<Ingredient> => {
      const response = await fetch(apiUrl('/ingredients'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw await readWriteError(response);
      return ((await response.json()) as IngredientCreateResponse).ingredient;
    },
    // 前缀失效：`useIngredients`（画像/编辑器搜索）与 `useAllIngredients`（字典页）一起刷
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ingredients'] }),
  });
}

/** 删一条食材（仅在零引用时成功）；失败时错误体里带**是哪一类引用、几条**。 */
export function useDeleteIngredient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<Ingredient> => {
      const response = await fetch(apiUrl(`/ingredients/${id}`), { method: 'DELETE', headers: { accept: 'application/json' } });
      if (!response.ok) throw await readWriteError(response);
      return ((await response.json()) as IngredientDeleteResponse).ingredient;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ingredients'] }),
  });
}

/**
 * 改一条食材（CONTEXT「改食材」；issue #35）：可改规范名、别名、时令月份、「含」指针。
 *
 * 成功后把两处缓存一起刷：`['ingredients']`（列表与搜索）与 `['ingredient-edits', id]`
 * （刚写的那一条要出现在改动台账里）。四个字段一个都没变时服务端报 409 `no_changes`，
 * 翻成人话是「这次提交没有任何改动」——不写台账、也不假装成功。
 */
export function usePatchIngredient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: IngredientPatch }): Promise<Ingredient> => {
      const response = await fetch(apiUrl(`/ingredients/${id}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw await readWriteError(response);
      return ((await response.json()) as IngredientPatchResponse).ingredient;
    },
    onSuccess: (_ingredient, variables) => {
      queryClient.invalidateQueries({ queryKey: ['ingredients'] });
      queryClient.invalidateQueries({ queryKey: ['ingredient-edits', variables.id] });
    },
  });
}

/**
 * 某条食材的改动台账（`GET /ingredients/:id/edits`，时间倒序）。
 * 与菜谱的 `useRecipeEdits` 并列、各自独立（两张表各自回答一个问题）。
 */
export function useIngredientEdits(ingredientId: string | null) {
  return useQuery({
    queryKey: ['ingredient-edits', ingredientId],
    queryFn: async ({ signal }): Promise<IngredientEditRecord[]> => {
      const response = await fetch(apiUrl(`/ingredients/${ingredientId}/edits`), {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`改动台账读取失败：HTTP ${response.status}`);
      return ((await response.json()) as IngredientEditListResponse).edits;
    },
    enabled: ingredientId !== null,
    staleTime: 60_000,
  });
}

/**
 * 这条食材被哪些地方引用、各几条（删之前先问清楚，界面据此给**说明**而不是一个必报错的按钮）。
 * 与 `DELETE` 同一份领域判定——两个接口不可能对「有没有人用它」看法不一致。
 */
export function useIngredientReferences(id: string | null) {
  return useQuery({
    queryKey: ['ingredient-references', id],
    queryFn: async ({ signal }): Promise<IngredientReferenceCount[]> => {
      const response = await fetch(apiUrl(`/ingredients/${id}/references`), { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`引用读取失败：HTTP ${response.status}`);
      return ((await response.json()) as IngredientReferencesResponse).references;
    },
    enabled: id !== null,
    staleTime: 0,
  });
}
