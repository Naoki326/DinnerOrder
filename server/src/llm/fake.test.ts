import { describe, expect, it } from 'vitest';
import { createFakeLlmClient } from './fake.js';
import { createUnconfiguredLlmClient } from './unconfigured.js';
import type { ToolDefinition } from './types.js';

const tools: ToolDefinition[] = [
  {
    name: 'seasonal_ingredients',
    description: '按月份给出时令食材（M2 会拆成 stdio MCP server）',
    inputSchema: { type: 'object', properties: { month: { type: 'number' } }, required: ['month'] },
  },
];

describe('fake LLM 客户端', () => {
  it('默认返回确定性的回显，同入参同出参', async () => {
    const llm = createFakeLlmClient(tools);
    const first = await llm.callTool('seasonal_ingredients', { month: 6 });
    const second = await llm.callTool('seasonal_ingredients', { month: 6 });
    expect(first).toEqual({
      content: JSON.stringify({ tool: 'seasonal_ingredients', args: { month: 6 } }),
    });
    expect(second).toEqual(first);
  });

  it('调用日志按序记录，且参数是深拷贝（调用方后续改动不会污染日志）', async () => {
    const llm = createFakeLlmClient(tools);
    const args = { month: 6, tags: ['时令'] };
    await llm.callTool('seasonal_ingredients', args);
    args.tags.push('改了');
    args.month = 12;

    expect(llm.calls).toEqual([{ name: 'seasonal_ingredients', args: { month: 6, tags: ['时令'] } }]);
  });

  it('未注册的工具直接抛错，不会静默返回空结果', async () => {
    const llm = createFakeLlmClient(tools);
    await expect(llm.callTool('unknown_tool', {})).rejects.toThrow(/未注册工具/);
  });

  it('编程的响应优先于默认回显，且可为函数', async () => {
    const llm = createFakeLlmClient(tools);
    llm.setToolResult('seasonal_ingredients', { content: '固定响应' });
    expect(await llm.callTool('seasonal_ingredients', { month: 6 })).toEqual({ content: '固定响应' });

    llm.setToolResult('seasonal_ingredients', (args) => ({ content: `月份 ${String(args.month)}` }));
    expect(await llm.callTool('seasonal_ingredients', { month: 9 })).toEqual({ content: '月份 9' });
  });

  it('编程的错误优先抛出（覆盖降级链的一环）', async () => {
    const llm = createFakeLlmClient(tools);
    llm.setToolResult('seasonal_ingredients', { content: '不该被返回' });
    llm.setToolError('seasonal_ingredients', new Error('模拟 schema 校验连败'));
    await expect(llm.callTool('seasonal_ingredients', {})).rejects.toThrow('模拟 schema 校验连败');
  });

  it('listTools 暴露 MCP 形状的工具定义', () => {
    const llm = createFakeLlmClient(tools);
    expect(llm.listTools()).toEqual(tools);
  });
});

describe('生产占位客户端', () => {
  it('无工具、调用即抛明确错误（真实实现留给 #17）', async () => {
    const llm = createUnconfiguredLlmClient();
    expect(llm.listTools()).toEqual([]);
    await expect(llm.callTool('anything', {})).rejects.toThrow(/#17/);
  });
});
