import { LlmCallError, type CompletionRequest, type CompletionResult, type LlmClient, type ToolCallResult, type ToolDefinition } from './types.js';

export interface FakeToolCallLogEntry {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeCompletionLogEntry {
  request: CompletionRequest;
  /** 本次是否以失败收场（拒答/超时/端点报错），失败也记——降级链的断言要看调用了几次 */
  ok: boolean;
}

export interface FakeLlmClient extends LlmClient {
  /** 按调用顺序记录的工具调用日志，断言「LLM 被调用了几次、带了什么参数」 */
  readonly calls: readonly FakeToolCallLogEntry[];
  /** 按调用顺序记录的 completion 日志（含失败调用） */
  readonly completionCalls: readonly FakeCompletionLogEntry[];
  /** 固定本次回复的文本（可用函数按入参产出）；同一次编程对所有调用生效 */
  setCompletion(result: string | ((request: CompletionRequest) => string | Promise<string>)): void;
  /** 排队若干次回复：调用一次弹一个，弹完回落到 setCompletion / 默认回显。用于覆盖降级链 */
  queueCompletion(...results: (string | Error | ((request: CompletionRequest) => string))[]): void;
  /** 让所有 completion 直接抛错（模拟端点不可用/超时） */
  setCompletionError(error: Error): void;
  /** 让模型固定返回的模型名（默认 'fake-llm'） */
  setModel(model: string): void;
  /** 编程序响应：注册某工具的固定返回（可为函数，按入参产出） */
  setToolResult(name: string, result: ToolCallResult | ((args: Record<string, unknown>) => ToolCallResult)): void;
  /** 编程序响应：让某工具调用直接抛错，用于覆盖降级路径 */
  setToolError(name: string, error: Error): void;
  /** 清空调用日志（保留编程的响应） */
  clearCalls(): void;
}

/**
 * 确定性 LLM fake（测试与 E2E 服务端共用）。
 * 不联网、不随机、不读环境变量——同一入参永远得到同一出参。
 *
 * `complete()` 的缺省行为是**回显 request 里的 prompt**（包成 JSON），
 * 于是「LLM 收到了什么」在测试里可以直接从出参读出来，不必让 fake 反解析 prompt。
 */
export function createFakeLlmClient(tools: ToolDefinition[] = []): FakeLlmClient {
  const toolDefs = new Map<string, ToolDefinition>(tools.map((tool) => [tool.name, tool]));
  const scripted = new Map<string, ToolCallResult | ((args: Record<string, unknown>) => ToolCallResult)>();
  const errors = new Map<string, Error>();
  const calls: FakeToolCallLogEntry[] = [];
  const completionCalls: FakeCompletionLogEntry[] = [];
  const completionQueue: (string | Error | ((request: CompletionRequest) => string))[] = [];
  let completionResult: string | ((request: CompletionRequest) => string | Promise<string>) | undefined;
  let completionError: Error | undefined;
  let model = 'fake-llm';

  return {
    get calls() {
      return calls;
    },
    get completionCalls() {
      return completionCalls;
    },
    get model() {
      return model;
    },
    setModel(next) {
      model = next;
    },
    setCompletion(result) {
      completionResult = result;
    },
    queueCompletion(...results) {
      completionQueue.push(...results);
    },
    setCompletionError(error) {
      completionError = error;
    },
    listTools() {
      return [...toolDefs.values()];
    },
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      const failure = errors.get(name);
      if (failure) throw failure;
      const scriptedResult = scripted.get(name);
      if (scriptedResult === undefined) {
        if (!toolDefs.has(name)) {
          throw new Error(`fake LLM 未注册工具：${name}`);
        }
        return { content: JSON.stringify({ tool: name, args }) };
      }
      return typeof scriptedResult === 'function' ? scriptedResult(args) : structuredClone(scriptedResult);
    },
    async complete(request) {
      const started = Date.now();
      const settle = (text: string): CompletionResult => {
        completionCalls.push({ request: structuredClone(request), ok: true });
        return { text, model, latencyMs: Math.max(0, Date.now() - started) };
      };
      try {
        if (completionError) throw completionError;
        const queued = completionQueue.shift();
        if (queued instanceof Error) throw queued;
        if (typeof queued === 'string') return settle(queued);
        if (queued) return settle(queued(request));
        if (completionResult !== undefined) {
          return settle(typeof completionResult === 'function' ? await completionResult(request) : completionResult);
        }
        // 缺省回显：把入参原样包成 JSON，测试可直接断言「LLM 被问了什么」
        return settle(JSON.stringify({ echo: { system: request.system, prompt: request.prompt } }));
      } catch (cause) {
        completionCalls.push({ request: structuredClone(request), ok: false });
        // 原始信息必须保留（降级链的 notes 就靠它说清「为什么这次是简化推荐」）：
        // 已经是 LlmCallError 就原样抛，其余包一层但把原消息带进去。
        if (cause instanceof LlmCallError) throw cause;
        throw new LlmCallError(cause instanceof Error ? cause.message : String(cause), { cause });
      }
    },
    setToolResult(name, result) {
      scripted.set(name, result);
    },
    setToolError(name, error) {
      errors.set(name, error);
    },
    clearCalls() {
      calls.length = 0;
      completionCalls.length = 0;
    },
  };
}
