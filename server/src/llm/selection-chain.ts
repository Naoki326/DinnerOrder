import type { LlmClient } from './types.js';
import { LlmCallError } from './types.js';
import type { RecommendationLlmMeta } from '../wire-types.js';

/**
 * 「让模型从池子里选」这件事的**降级链**（总纲 §4、spec S7）：strict `json_schema` 试 2 次
 * → `json_object` + 本地校验试 2 次 → 交给调用方按规则兜底。
 *
 * 为什么抽出来：整餐推荐（`domain/recommendation.ts`）与换菜候选（`domain/replacement.ts`）
 * 走的是**同一条链**——同样的超时、温度、每档重试次数、「失败也要记一句为什么」的纪律；
 * 两者不同的只有：出参形状（整餐 vs 候选）、校验规则、和几句给家人看的文案。
 * 各写一遍的代价不是重复 40 行，而是两条链会悄悄漂移（一边改了重试次数、另一边没改）。
 *
 * 调用方负责兜底（规则排序）：这里只把「LLM 这一侧发生了什么」如实带出来。
 */

/** 单次 LLM 调用超时（spec §4②：超时 30s）
 * TODO(#26 统一收口)：进家规表（家规 = 单例配置，全部可调，总纲 §3）。 */
const LLM_TIMEOUT_MS = 30_000;

/** 采样温度（spec §4②：0.7——要一点变化，否则同一餐永远推同样的菜） */
const LLM_TEMPERATURE = 0.7;

/** 每个档最多试 2 次：第 1 次失败后重试 1 次（网络/超时与形状不合一视同仁） */
const MAX_ATTEMPTS_PER_FORMAT = 2;

/** 一层校验的结果：失败时必须给一句**可读的**原因（它会进 notes，家人看得到） */
export type SelectionCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SelectionChainOptions<T> {
  llm: LlmClient;
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  check: (text: string) => SelectionCheck<T>;
  /** 落进留痕的模板版本号（模板进代码库 git 管版本，总纲 §3 决议 3） */
  promptVersion: string;
  /** strict 档失败、由 JSON 档完成时补的说明（两条链的文案不同：一个说「本餐」一个说「候选」） */
  jsonObjectNote: string;
  /** 两档四次都失败时的说明（调用方随后会按规则兜底） */
  fallbackNote: string;
}

export interface SelectionChainResult<T> {
  /** LLM 给出的合法挑选；`undefined` = 四次都没成功，调用方该按规则兜底 */
  value: T | undefined;
  meta: RecommendationLlmMeta;
  /** 降级链的痕迹（含每次失败的原因）；调用方可以再往里补自己的说明 */
  notes: string[];
}

export async function runSelectionChain<T>(options: SelectionChainOptions<T>): Promise<SelectionChainResult<T>> {
  const { llm, system, prompt, check } = options;
  const notes: string[] = [];
  let latencyMs = 0;
  let model = llm.model;

  for (const format of ['json_schema', 'json_object'] as const) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_FORMAT; attempt += 1) {
      const label = format === 'json_schema' ? '严格 schema 档' : 'JSON 档';
      try {
        const result = await llm.complete({
          system,
          prompt,
          responseFormat: format,
          jsonSchema: format === 'json_schema' ? options.jsonSchema : undefined,
          timeoutMs: LLM_TIMEOUT_MS,
          temperature: LLM_TEMPERATURE,
        });
        latencyMs += result.latencyMs;
        model = result.model || model;

        const outcome = check(result.text);
        if (outcome.ok) {
          return {
            value: outcome.value,
            meta: { model, promptVersion: options.promptVersion, latencyMs, degraded: format !== 'json_schema', format },
            notes: format === 'json_object' ? [...notes, options.jsonObjectNote] : notes,
          };
        }
        notes.push(`${label}第 ${attempt} 次：${outcome.reason}`);
      } catch (cause) {
        notes.push(`${label}第 ${attempt} 次：${errorText(cause)}`);
      }
    }
  }

  notes.push(options.fallbackNote);
  return {
    value: undefined,
    meta: { model, promptVersion: options.promptVersion, latencyMs, degraded: true, format: 'rules_only' },
    notes,
  };
}

function errorText(cause: unknown): string {
  if (cause instanceof LlmCallError) return cause.message;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
