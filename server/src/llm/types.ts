/**
 * LLM / 工具调用的 seam。
 *
 * 形状按 MCP 设计（工具名 + 描述 + JSON Schema 参数），M1 进程内直调，M2 再把时令食材这类
 * 外部数据源拆成 stdio MCP server（spec §4、ADR-0001）。**推荐管线不用工具调用**——
 * «只从检索池中选菜» 是 ADR-0001 的决议，工具面留在这里是给 M2 的时令食材用的。
 *
 * 推荐要的那条路是 `complete()`：单次纯 completion、要 JSON 出参。它和 callTool 并列而不是
 * 塞进工具集：工具是「问一句数据」，completion 是「让模型做一次选择」，两者的重试与降级
 * 语义完全不同（见 domain/recommendation.ts 的降级链）。
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 形状的参数定义 */
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  content: string;
  isError?: boolean;
}

/**
 * 出参格式两档：
 * - `json_schema`：strict 结构化输出（DashScope/百炼支持；本机代理端点不支持，见下）
 * - `json_object`：只保证是 JSON，形状靠 Zod 校验
 *
 * **本机代理端点（127.0.0.1:8004）实测不支持 strict `json_schema`**：传了它会返回自由文本，
 * 甚至带 markdown 代码块。所以降级链里「strict 档失败」在本环境是常态而非异常——
 * 真实部署（DashScope）那一档仍然保留，两档共用同一个完成调用（preflight 记录的能力差异）。
 */
export type CompletionFormat = 'json_schema' | 'json_object';

export interface CompletionRequest {
  system: string;
  prompt: string;
  responseFormat: CompletionFormat;
  /** 仅 responseFormat='json_schema' 时使用（JSON Schema 对象，另行 strict 化） */
  jsonSchema?: Record<string, unknown>;
  /** 单次调用超时（毫秒）；超时算失败、进降级链 */
  timeoutMs: number;
  /** 采样温度；推荐要一点变化（spec §4 的温度 0.7），所以显式给 */
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  /** 实际使用的模型名（响应里的 model，落进留痕） */
  model: string;
  /** 本次调用的墙钟耗时（毫秒，落进留痕） */
  latencyMs: number;
}

/** LLM 调用失败（网络/超时/端点报错都归这一类），编排层据它决定要不要重试或降级 */
export class LlmCallError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'LlmCallError';
  }
}

export interface LlmClient {
  /** 当前模型名（不参与判定，只作可观测性与留痕） */
  readonly model: string;
  listTools(): ToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** 单次纯 completion：推荐管线的唯一 LLM 入口 */
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
