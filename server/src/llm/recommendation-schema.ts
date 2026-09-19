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
