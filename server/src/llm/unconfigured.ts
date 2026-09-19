import { LlmCallError, type LlmClient } from './types.js';

/**
 * 未配置 LLM 时的占位客户端：没有 `.env`（或 key 为空）时生产/开发入口注入它。
 *
 * 与「调用即抛」的早期版本不同，`complete()` 现在抛的是 **LlmCallError**——
 * 推荐编排层把 LLM 失败一律降级成简化推荐（总纲 §4），所以没配 key 时用户拿到的是
 * 一段带显著标记的规则推荐，而不是一个错误页。工具面（M2 的 MCP）仍然直接抛：
 * 那时调用方需要的是「没配」这个事实，而不是降级。
 */
export function createUnconfiguredLlmClient(): LlmClient {
  return {
    model: 'unconfigured',
    listTools: () => [],
    callTool: async () => {
      throw new Error('LLM 客户端未配置：工具面（MCP）由 M2 接入；见 llm/openai.ts');
    },
    complete: async () => {
      throw new LlmCallError('LLM 客户端未配置：没有 OPENAI_API_KEY / OPENAI_BASE_URL，本餐走简化推荐');
    },
  };
}
