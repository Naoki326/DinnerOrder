/**
 * LLM / 工具调用的 seam。
 *
 * 形状按 MCP 设计（工具名 + 描述 + JSON Schema 参数），M1 进程内直调，M2 再把时令食材这类
 * 外部数据源拆成 stdio MCP server（spec §4、ADR-0001）。
 *
 * 本票只落桩：真实客户端（`openai` 包接百炼兼容端点、strict json_schema → json_object + Zod 重试的
 * 降级链）由 #17 实现。测试与 E2E 一律注入 `createFakeLlmClient()`，实施期不真调 LLM。
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

export interface LlmClient {
  listTools(): ToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}
