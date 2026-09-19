import type { Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';

/**
 * 冒烟 API：一条请求同时证明「HTTP 通道可用」「时钟是注入的」「LLM 客户端是注入的」。
 * `?tools=0|1` 走一遍 zod 校验通道（真实入参校验在后续工单里长在各自的领域路由上）。
 */
const healthQuerySchema = z.object({
  tools: z.enum(['0', '1']).default('1'),
});

export function registerHealthRoutes(api: Hono, deps: AppDeps): void {
  api.get('/health', zodValidator('query', healthQuerySchema), (c) => {
    const { tools } = c.req.valid('query');
    return c.json({
      ok: true,
      /** 注入时钟的当前值：测试拨动时钟后无需重启进程即可观测 */
      serverTime: deps.clock.now().toISOString(),
      basePath: deps.basePath,
      llm: {
        tools:
          tools === '1'
            ? deps.llm.listTools().map((tool) => ({ name: tool.name, description: tool.description }))
            : [],
      },
    });
  });
}
