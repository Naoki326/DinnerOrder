import type { LlmClient } from './types.js';

/**
 * 生产占位客户端：真实 LLM 客户端（`openai` 包 + 百炼兼容端点 + 降级链）由 #17 接上。
 * 现在任何调用都抛清晰错误，避免「静默返回空推荐」这种更难查的失败形态。
 */
export function createUnconfiguredLlmClient(): LlmClient {
  const notConfigured = (): never => {
    throw new Error('LLM 客户端未配置：真实 client 由 #17（LLM 管线接入）实现；生产与开发入口当前注入 createUnconfiguredLlmClient()');
  };
  return {
    listTools: () => [],
    callTool: async () => notConfigured(),
  };
}
