import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { LlmCallError, type CompletionRequest, type CompletionResult, type LlmClient } from './types.js';

/**
 * 真实 LLM 客户端：官方 `openai` 包接 OpenAI 兼容端点（百炼 DashScope，或本机代理）。
 *
 * 三个刻意的决定：
 *
 * 1. **`maxRetries: 0`**：网络重试属于降级链，写在编排层（domain/recommendation.ts），
 *    这样「重试了几次、重试后走哪一档」在 fake 上可测、在留痕里可见。SDK 自带的隐形重试
 *    会让「一次调用」变成不确定的多次，降级链的断言就失去意义。
 * 2. **`response_format` 两档分开拼**：strict `json_schema` 只在调用方明确要求时传。
 *    本机代理端点不认它（会返回自由文本），所以编排层会在校验失败后降到 `json_object`。
 * 3. **DEBUG=1 才落请求/响应**（spec §4）：落到 `data/logs/`，与 `.env` 同级被备份排除。
 *    落盘的内容里**没有 key**（Authorization 头不进日志），只有模型、耗时、正文。
 */

export interface OpenAiLlmOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** DEBUG=1 时把请求/响应写到这个目录（缺省不写） */
  debugLogDir?: string;
}

/** 端点未配置（缺 key 或 baseURL）时抛，启动期就能发现，而不是等到用户点推荐 */
export class LlmNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`LLM 未配置：缺少 ${missing}（在仓库根 .env 里设置；见 README 运行时配置）`);
    this.name = 'LlmNotConfiguredError';
  }
}

/**
 * 从环境变量建客户端；缺 key/baseURL 时返回 undefined，由调用方决定用哪个占位实现。
 *
 * `createUnconfiguredLlmClient()` 仍然保留：开发/测试里「没配 LLM」是常见状态，
 * 那种状态下点推荐应该拿到一句人话（走简化推荐），而不是启动就崩。
 */
export function createOpenAiLlmClient(options: OpenAiLlmOptions): LlmClient {
  if (!options.apiKey.trim()) throw new LlmNotConfiguredError('OPENAI_API_KEY');
  if (!options.baseUrl.trim()) throw new LlmNotConfiguredError('OPENAI_BASE_URL');

  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    // 见文件头：重试在编排层，SDK 不许自己重试
    maxRetries: 0,
  });

  return {
    model: options.model,
    listTools: () => [],
    async callTool(name) {
      throw new LlmCallError(`M1 不在进程内调用工具（${name}）：工具面留给 M2 的 MCP server（ADR-0001）`);
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const started = Date.now();
      const startedAt = new Date(started);
      try {
        const response = await client.chat.completions.create(
          {
            model: options.model,
            temperature: request.temperature ?? 0.7,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt },
            ],
            response_format: responseFormat(request),
          },
          { timeout: request.timeoutMs },
        );
        const text = response.choices[0]?.message?.content ?? '';
        const result: CompletionResult = {
          text,
          model: response.model || options.model,
          latencyMs: Date.now() - started,
        };
        writeDebugLog(options.debugLogDir, { startedAt, request, result });
        return result;
      } catch (cause) {
        writeDebugLog(options.debugLogDir, { startedAt, request, error: describeError(cause) });
        throw new LlmCallError(`LLM 调用失败（${options.model}）：${describeError(cause)}`, { cause });
      }
    },
  };
}

/**
 * 出参格式：strict schema 走 `json_schema`（含 `strict:true`），否则 `json_object`。
 * 两档都用 SDK 的联合类型里存在的形状，不额外发明字段。
 */
function responseFormat(request: CompletionRequest): OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] {
  if (request.responseFormat === 'json_schema' && request.jsonSchema) {
    return {
      type: 'json_schema',
      json_schema: { name: 'meal_recommendation', strict: true, schema: request.jsonSchema },
    };
  }
  return { type: 'json_object' };
}

/**
 * DEBUG=1 落盘（spec §4）：完整请求/响应只在调试时落 `data/logs/`。
 *
 * 写失败**吞掉异常**：日志是旁路，不能因为它把推荐本身弄失败（磁盘满、目录只读都不该
 * 让家人点不出推荐）。正文里没有任何凭据——Authorization 头不过这里。
 */
function writeDebugLog(
  dir: string | undefined,
  entry: { startedAt: Date; request: CompletionRequest; result?: CompletionResult; error?: string },
): void {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = entry.startedAt.toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `llm-${stamp}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          at: entry.startedAt.toISOString(),
          model: entry.result?.model,
          responseFormat: entry.request.responseFormat,
          temperature: entry.request.temperature ?? 0.7,
          // 允许落 prompt 正文（那是可解释性的证据），但绝不落环境变量与凭据
          system: entry.request.system,
          prompt: entry.request.prompt,
          response: entry.result?.text,
          error: entry.error,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // 旁路日志失败不抛
  }
}

/**
 * 错误描述：**先脱敏再截断**。
 *
 * SDK 的报错正文会回引请求内容，实测 401 的 message 里带着完整 key（`Incorrect API key
 * provided: sk-...`）。这条消息会经 `LlmCallError` → 推荐 `notes` → 接口响应 → 界面展示，
 * 也会在 `DEBUG=1` 时落 `data/logs/`——所以脱敏必须在**源头**做，不能指望下游。
 */
function describeError(cause: unknown): string {
  const raw = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return redactSecrets(raw).slice(0, 500);
}

/**
 * 抹掉错误文本里像凭据的片段。
 *
 * 不追求穷举（凭据形态无穷），而是盖住真实会出现的几类：`sk-` 开头的 key、
 * 常见前缀的 token、`Authorization`/`api[_-]?key` 后面跟的值。多抹一点无害——
 * 报错里少几个字符，总比把家里的 key 写进日志强。
 */
function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/(authorization|api[_-]?key|cookie|set-cookie)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b(?=["'\s,)]*$)/g, '[redacted]');
}
