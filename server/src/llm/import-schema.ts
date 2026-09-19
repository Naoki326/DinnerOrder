import { z } from 'zod';
import { LlmCallError, type LlmClient } from './types.js';
import { stripCodeFence } from './prompt.js';
import type { RecipeCuisine } from '../wire-types.js';

/**
 * 导入期的 LLM 出参形状（总纲 §2.8：「模糊份量一律由 LLM 重标到成人份克数」+
 * 「菜系参考 tag 导入时 LLM 初打」）。两件事都是**离线路径**（导入/转正时跑一次），
 * 与运行时数值路径（份量引擎，ADR-0004 纯规则查表）严格分开。
 *
 * 出参格式按本环境实测的能力走（preflight 记录）：本机代理端点**不支持 strict json_schema**
 * （传了它返回自由文本、可能带 markdown 包装），所以这里只走 `json_object` +
 * **Zod 校验 + 失败重试**——这正是 preflight 指明的那一档。真实部署（DashScope）支持 strict，
 * 但离线导入不是性能敏感的运行时路径，两档共用一个 `json_object` 通道即可，
 * 不必为此再加一层（推荐管线的降级链有它有道理：那在用户等着的一秒里；导入是后台跑批）。
 *
 * 三条纪律：
 *   1. **只信校验过的数字**：`grams` 必须落在 1–2000 的合理区间，否则这一项算没重标
 *      （宁可留 0 进 `relabel.pending`，也不把一个离谱的值写进成人份基准——它会经份量引擎
 *      一路放大到买菜清单）。
 *   2. **提示词里的份量原文是证据**：模型看到的是「两勺」「约 3~4 斤」这类原文，
 *      不是我们替它猜的数（采集器不猜，见 `library/collectors.ts`）。
 *   3. **菜系值域封闭**：与迁移 005 的 CHECK 白名单一字不差，把 `RecipeCuisine` 当唯一来源。
 */

/** 菜系白名单：与 `RecipeCuisine` 同源，落库前用它挡一遍（LLM 会编出「京菜」「鲁菜」这种带字的） */
export const CUISINES: readonly RecipeCuisine[] = ['川', '粤', '鲁', '苏浙', '湘', '东北', '闽', '徽', '西北', '京', '家常'];

/** 一次重标的输入：一道菜里**还没重标**的那些食材项（`quantity` 是原文份量，模型据此判断） */
export interface RelabelRequest {
  recipeId: string;
  recipeName: string;
  ingredients: { name: string; quantity: string }[];
}

export interface RelabelAssignment {
  recipeId: string;
  ingredients: { name: string; grams: number }[];
}

const RELABEL_SCHEMA = z.object({
  dishes: z
    .array(
      z.object({
        recipeId: z.string().min(1),
        ingredients: z
          .array(
            z.object({
              name: z.string().min(1),
              /** 成人份克数：区间是**下界防 0、上界防幻觉**（2000g 一个食材项已远超任何家常菜） */
              grams: z.number().positive().max(2000),
            }),
          )
          .default([]),
      }),
    )
    .min(1, '一道菜都没给'),
});

const CUISINE_SCHEMA = z.object({
  dishes: z
    .array(
      z.object({
        recipeId: z.string().min(1),
        /** 值域封闭：模型给别的就丢掉这一条（不写库 = 保持 null，转正时掌勺者补） */
        cuisine: z.string().min(1),
      }),
    )
    .min(1, '一道菜都没给'),
});

const RELABEL_SYSTEM = [
  '你是中餐家常菜谱的份量标准化助手。',
  '任务：把每道菜里「适量 / 少许 / 两勺 / 3 瓣」这类模糊份量，换算成**一个成人一餐**这道菜时该用的**生重克数**。',
  '严格遵守：',
  '1. 只输出 JSON，不要 markdown 代码块，不要解释文字。',
  '2. 每道菜的 ingredient 名字必须**原样照抄**输入里的名字，不要改写、不要增删。',
  '3. 数字是「一个成人的一餐量」：叶菜 150–250g、根茎 100–200g、肉 100–150g、鸡蛋 50–60g（一个）、',
  '   食用油 10–15g、盐 2–3g、生抽 10–15g、糖 3–10g、淀粉 5–10g、蒜 5–10g、姜 3–8g、葱 5–10g。',
  '4. 拿不准就给一个**中式家常的中间值**，不要给 0，不要给超过 500 的调料量。',
  '输出 JSON 形状：{"dishes":[{"recipeId":"<原样>","ingredients":[{"name":"<原样>","grams":12}]}]}',
].join('\n');

const CUISINE_SYSTEM = [
  '你是中餐菜系的标注助手。任务是给每道菜打一个**菜系参考标签**（不是分类判定，只作参考）。',
  `只能从这个封闭集合里选一个：${CUISINES.join('、')}。`,
  '跨菜系的家庭做法、说不清归属的一律给「家常」。',
  '只输出 JSON，不要 markdown 代码块，不要解释文字。形状：',
  '{"dishes":[{"recipeId":"<原样>","cuisine":"川"}]}',
].join('\n');

export interface ImportLlmOptions {
  /** 一次问几道菜（批量是必须的：150–300 道一道一问会打几百次端点） */
  batchSize?: number;
  /** 每个批次最多试几次（网络抖动重试 1 次；形状不合也重试 1 次） */
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface RelabelOutcome {
  assignments: RelabelAssignment[];
  /** 实际调用了几次端点（报告里的成本可见性） */
  calls: number;
  /** 失败/丢弃的说明（进报告 notes，不静默） */
  notes: string[];
}

/**
 * 批量重标（离线路径）。**失败不抛**：某一批重标不出来，那批留 0 克进
 * `relabel.pending`，报告里如实列出——导入不能因为 LLM 抽风就整批失败。
 */
export async function relabelPortions(
  llm: LlmClient,
  requests: RelabelRequest[],
  options: ImportLlmOptions = {},
): Promise<RelabelOutcome> {
  const batchSize = options.batchSize ?? 6;
  const assignments: RelabelAssignment[] = [];
  const notes: string[] = [];
  let calls = 0;

  for (const batch of chunk(requests, batchSize)) {
    const outcome = await askJson(llm, {
      system: RELABEL_SYSTEM,
      prompt: [
        '请为下面每道菜里列出的食材项给出成人份生重克数（单位：克）。',
        JSON.stringify(
          batch.map((request) => ({
            recipeId: request.recipeId,
            name: request.recipeName,
            ingredients: request.ingredients,
          })),
        ),
      ].join('\n'),
      options,
    });
    calls += outcome.calls;
    if (outcome.text === undefined) {
      notes.push(`份量重标第 ${calls} 次调用失败：${outcome.reason}`);
      continue;
    }
    const parsed = RELABEL_SCHEMA.safeParse(parseJson(outcome.text));
    if (!parsed.success) {
      notes.push(`份量重标出参形状不合：${parsed.error.issues[0]?.message ?? '未知'}`);
      continue;
    }
    // 只收「在这次请求里问过的菜 + 问过的食材名」：模型多给的、改了名的都不要
    const requested = new Map(batch.map((request) => [request.recipeId, new Set(request.ingredients.map((item) => item.name))]));
    for (const dish of parsed.data.dishes) {
      const names = requested.get(dish.recipeId);
      if (!names) continue;
      const kept = dish.ingredients.filter((item) => names.has(item.name));
      if (kept.length > 0) assignments.push({ recipeId: dish.recipeId, ingredients: kept });
    }
  }

  return { assignments, calls, notes };
}

export interface CuisineOutcome {
  /** recipeId → 菜系（只含 LLM 真给且值域内的那些） */
  cuisines: Map<string, RecipeCuisine>;
  calls: number;
  notes: string[];
}

/**
 * 菜系参考 tag 的**初打**（§2.8）。只有采集器/名称启发式给不出确定值的那些才问——
 * 「麻婆豆腐 → 川」不需要花一次调用，采集器的 `cuisineHintFrom` 已经答了。
 */
export async function classifyCuisines(
  llm: LlmClient,
  requests: { recipeId: string; recipeName: string; tasteHint: string[] }[],
  options: ImportLlmOptions = {},
): Promise<CuisineOutcome> {
  const batchSize = options.batchSize ?? 12;
  const cuisines = new Map<string, RecipeCuisine>();
  const notes: string[] = [];
  let calls = 0;

  for (const batch of chunk(requests, batchSize)) {
    const outcome = await askJson(llm, {
      system: CUISINE_SYSTEM,
      prompt: [
        '请给下面每道菜打一个菜系参考标签。',
        JSON.stringify(batch.map((request) => ({ recipeId: request.recipeId, name: request.recipeName, tastes: request.tasteHint }))),
      ].join('\n'),
      options,
    });
    calls += outcome.calls;
    if (outcome.text === undefined) {
      notes.push(`菜系初打第 ${calls} 次调用失败：${outcome.reason}`);
      continue;
    }
    const parsed = CUISINE_SCHEMA.safeParse(parseJson(outcome.text));
    if (!parsed.success) {
      notes.push(`菜系初打出参形状不合：${parsed.error.issues[0]?.message ?? '未知'}`);
      continue;
    }
    const allowed = new Set(CUISINES as readonly string[]);
    for (const dish of parsed.data.dishes) {
      if (!allowed.has(dish.cuisine)) continue;
      cuisines.set(dish.recipeId, dish.cuisine as RecipeCuisine);
    }
  }

  return { cuisines, calls, notes };
}

/** 一次 `json_object` 调用 + 重试（**不用 strict 档**，理由见文件头） */
async function askJson(
  llm: LlmClient,
  request: { system: string; prompt: string; options: ImportLlmOptions },
): Promise<{ text?: string; calls: number; reason: string }> {
  const maxAttempts = request.options.maxAttempts ?? 2;
  let calls = 0;
  let reason = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    calls += 1;
    try {
      const result = await llm.complete({
        system: request.system,
        prompt: request.prompt,
        responseFormat: 'json_object',
        timeoutMs: request.options.timeoutMs ?? 60_000,
        // 导入是**离线批处理**：要的是可复现的份量基准，不是每次跑都变的菜谱
        temperature: 0.2,
      });
      return { text: result.text, calls, reason: '' };
    } catch (cause) {
      reason = cause instanceof LlmCallError ? cause.message : String(cause);
    }
  }
  return { calls, reason };
}

/** JSON.parse 前的清洗只做一层：剥掉 markdown 代码块（端点偶尔仍会包） */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return undefined;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
