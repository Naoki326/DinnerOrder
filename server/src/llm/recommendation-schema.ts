import { z } from 'zod';
import { stripCodeFence } from './prompt.js';
import type { RecipeKind, RecommendationStructure } from '../wire-types.js';

/**
 * LLM 出参的形状与校验（spec §4③：`{菜品:[{菜谱id, 理由一句话, 来源:家庭/外部}]}`）。
 *
 * 两档共用同一份校验：
 * - strict 档给的 `RECOMMENDATION_JSON_SCHEMA` 是**给端点看的**（json_schema + strict）；
 * - `SELECTION_SCHEMA` 是**给自己看的**（json_object 档、以及 strict 档返回值的复核）。
 *
 * 后者的存在理由：本机代理端点不认 strict（preflight 记录的能力差异），会照样返回自由文本；
 * 端点层面「它说它验证了」和「我们确实检查过」是两件事，幻觉的入口在这一层关掉
 * （ADR-0001：输出只能是从候选池里挑的 id）。
 */

export const SELECTION_SCHEMA = z.object({
  dishes: z
    .array(
      z.object({
        recipeId: z.string().min(1, 'recipeId 不能为空'),
        reason: z.string().min(1, '每道菜都要给一句理由'),
      }),
    )
    .min(1, '一道菜都没给'),
});

/** 给 strict `json_schema` 档用的 JSON Schema（字段与 SELECTION_SCHEMA 一一对应） */
export const RECOMMENDATION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['dishes'],
  properties: {
    dishes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recipeId', 'reason'],
        properties: {
          recipeId: { type: 'string', description: '候选池里某道菜的 id（必须原样照抄）' },
          reason: { type: 'string', description: '为什么这一餐配它，一句中文，20 字以内' },
        },
      },
    },
  },
};

/** 校验通过的挑选结果 */
export interface SelectionDish {
  recipeId: string;
  reason: string;
}

export type SelectionCheck = { ok: true; dishes: SelectionDish[] } | { ok: false; reason: string };

/**
 * 把 LLM 的文本回复校验成「一份合法的挑选」。
 *
 * 四层，从便宜到贵：① 是 JSON（容忍 markdown 包裹）② 形状对（Zod）
 * ③ 每道菜都在候选池里（幻觉入口）④ 荤素结构满足家规（spec §4②：结构由规则定，LLM 只填位）。
 * 任一失败都带上**可读的原因**——降级链把它拼进 notes，家人看到的是「为什么这次是简化推荐」。
 */
export function checkSelection(
  text: string,
  pool: { id: string; kind: RecipeKind }[],
  structure: RecommendationStructure,
): SelectionCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    return { ok: false, reason: '回复不是合法 JSON' };
  }

  const parsed = SELECTION_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `形状不对（${issue?.path.join('.') || '根'}：${issue?.message ?? '未知'}）` };
  }

  const byId = new Map(pool.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const counts = { meat: 0, veg: 0, soup: 0 };
  for (const dish of parsed.data.dishes) {
    const entry = byId.get(dish.recipeId);
    if (!entry) return { ok: false, reason: `出现了候选池里没有的菜：${dish.recipeId}` };
    if (seen.has(dish.recipeId)) return { ok: false, reason: `同一道菜选了两次：${dish.recipeId}` };
    seen.add(dish.recipeId);
    counts[positionOf(entry.kind)] += 1;
  }

  const want = { meat: structure.meat, veg: structure.veg, soup: structure.soup };
  if (counts.meat !== want.meat || counts.veg !== want.veg || counts.soup !== want.soup) {
    return {
      ok: false,
      reason: `结构不符：要荤 ${want.meat}/素 ${want.veg}/汤 ${want.soup}，实际荤 ${counts.meat}/素 ${counts.veg}/汤 ${counts.soup}`,
    };
  }
  return { ok: true, dishes: parsed.data.dishes };
}

export function positionOf(kind: RecipeKind): 'meat' | 'veg' | 'soup' {
  if (kind === 'meat') return 'meat';
  if (kind === 'veg') return 'veg';
  return 'soup';
}

// ---------------------------------------------------------------- 换菜候选（M1-06）

/** 换菜候选的出参形状（换菜请求没有结构约束，只有「条数上限 + 池内 + 不重复」） */
const CANDIDATE_SELECTION_SCHEMA = z.object({
  candidates: z
    .array(
      z.object({
        recipeId: z.string().min(1, 'recipeId 不能为空'),
        reason: z.string().min(1, '每个候选项都要给一句理由'),
      }),
    )
    .min(1, '一个候选都没给'),
});

/** 一次给几个候选（spec §2.3：3 个）。声明在 schema 之前：`CANDIDATE_JSON_SCHEMA` 的 `maxItems` 用它，
 * 条数上限全仓只该有一处数字——两处写死就会在下一次调整时悄然不一致。 */
export const MAX_CANDIDATES = 3;

/** 给 strict `json_schema` 档用的 JSON Schema（字段与 CANDIDATE_SELECTION_SCHEMA 一一对应） */
export const CANDIDATE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_CANDIDATES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recipeId', 'reason'],
        properties: {
          recipeId: { type: 'string', description: '同位候选池里某道菜的 id（必须原样照抄）' },
          reason: { type: 'string', description: '为什么适合替换掉这一道，一句中文，20 字以内' },
        },
      },
    },
  },
};

export type CandidateCheck =
  | { ok: true; candidates: SelectionDish[] }
  | { ok: false; reason: string };

/**
 * 把 LLM 的文本回复校验成「一组合法的换菜候选」。
 *
 * 与整餐 `checkSelection` 同一条纪律（ADR-0001）：① 是 JSON ② 形状对（Zod）
 * ③ 每个候选都在池里（幻觉入口）④ 不重复 ⑤ 条数 = min(3, 池子大小)。
 * 第 ⑤ 条是换菜特有的：池子只剩 2 道时选 3 个必然幻觉，必须当场拦下。
 */
export function checkCandidates(text: string, pool: { id: string }[]): CandidateCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    return { ok: false, reason: '回复不是合法 JSON' };
  }

  const parsed = CANDIDATE_SELECTION_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `形状不对（${issue?.path.join('.') || '根'}：${issue?.message ?? '未知'}）` };
  }

  const byId = new Map(pool.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const candidate of parsed.data.candidates) {
    if (!byId.has(candidate.recipeId)) {
      return { ok: false, reason: `出现了候选池里没有的菜：${candidate.recipeId}` };
    }
    if (seen.has(candidate.recipeId)) return { ok: false, reason: `同一个候选给了两次：${candidate.recipeId}` };
    seen.add(candidate.recipeId);
  }

  const want = Math.min(MAX_CANDIDATES, pool.length);
  // 「池子够却少给」也判失败（重试一次也许就够了）；池子本来就不够时按池子算
  if (parsed.data.candidates.length !== want) {
    return { ok: false, reason: `候选条数不符：要 ${want} 个，给了 ${parsed.data.candidates.length} 个` };
  }
  return { ok: true, candidates: parsed.data.candidates };
}
