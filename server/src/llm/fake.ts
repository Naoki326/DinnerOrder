import type { LlmClient, ToolCallResult, ToolDefinition } from './types.js';

export interface FakeToolCallLogEntry {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeLlmClient extends LlmClient {
  /** 按调用顺序记录的调用日志，断言「LLM 被调用了几次、带了什么参数」 */
  readonly calls: readonly FakeToolCallLogEntry[];
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
 */
export function createFakeLlmClient(tools: ToolDefinition[] = []): FakeLlmClient {
  const toolDefs = new Map<string, ToolDefinition>(tools.map((tool) => [tool.name, tool]));
  const scripted = new Map<string, ToolCallResult | ((args: Record<string, unknown>) => ToolCallResult)>();
  const errors = new Map<string, Error>();
  const calls: FakeToolCallLogEntry[] = [];

  return {
    get calls() {
      return calls;
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
    setToolResult(name, result) {
      scripted.set(name, result);
    },
    setToolError(name, error) {
      errors.set(name, error);
    },
    clearCalls() {
      calls.length = 0;
    },
  };
}
