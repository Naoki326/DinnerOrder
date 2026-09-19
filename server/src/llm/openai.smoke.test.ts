import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../config.js';
import { recommendMeal } from '../domain/recommendation.js';
import { createTestHarness } from '../testing/harness.js';
import { createOpenAiLlmClient } from './openai.js';
import type { CompletionResult } from './types.js';

/**
 * 真调用冒烟（spec §4、issue #17 AC「真调用冒烟」）：真打端点，验证接线与整条管线在**真模型**上跑得通。
 *
 * 三条纪律：
 *
 * 1. **缺 key 就 skip，不失败**：CI/他人机器上没有 `.env` 是常态，把「没配」当成红色
 *    会让人习惯性忽略失败——那比不测更糟。
 * 2. **总共两次调用**（一次裸 completion + 一次完整推荐）：真调用的成本与耗时都不归测试管，
 *    冒烟只需要证明「线通了」，不做无节制的循环。
 * 3. **权限最小**：断言只谈形状与自洽（非空正文、结构配满、格式与 degraded 一致）；
 *    **不把模型名、端点、响应正文写进断言消息**（失败信息会进日志，而日志可能被贴到 issue 里）。
 *
 * 环境事实（preflight）：本机端点对 `json_schema` strict **不支持**——那正是降级链第一档
 * 要处理的现实。所以这里**不断言** strict 一定生效，只断言两档都接得上时结果总是合法的。
 */
function loadRootEnv(): void {
  const envFile = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    // Node 22 原生支持：不引 dotenv 依赖，也不会把 `.env` 内容打到任何输出
    process.loadEnvFile(envFile);
  } catch {
    // 已经加载过 / 文件权限不足：交给下面的 skip 判定
  }
}

loadRootEnv();

const hasCredentials = Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.OPENAI_BASE_URL?.trim());

describe.skipIf(!hasCredentials)('真实 LLM 冒烟（无 .env 时 skip）', () => {
  it('一次纯 completion 能打通端点并拿回正文与模型名', async () => {
    const llm = createOpenAiLlmClient({
      apiKey: process.env.OPENAI_API_KEY!,
      baseUrl: process.env.OPENAI_BASE_URL!,
      model: process.env.LLM_MODEL?.trim() || 'qwen3.8-flash',
      // 与生产同一口径：DEBUG=1 才落盘（排查推荐效果时用；不落 key）
      debugLogDir: process.env.DEBUG === '1' ? path.join(REPO_ROOT, 'data/logs') : undefined,
    });

    const result: CompletionResult = await llm.complete({
      system: '你是一个只输出 JSON 的助手。',
      prompt: '只回一个 JSON 对象：{"ok":true}',
      responseFormat: 'json_object',
      timeoutMs: 30_000,
      temperature: 0,
    });

    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThan(0);
  }, 45_000);

  /**
   * 整条管线的真调用：规则池子 → 真模型选 → 校验。
   *
   * 不断言走了哪一档：本机端点不支持 strict，真部署（DashScope）支持——那是环境差异，
   * 不是代码性质。断言的是两档都接得上时**结果总是合法**的（结构满、每道都有理由）。
   */
  it('整餐推荐在真模型上跑通：结构配满、每道有理由', async () => {
    const harness = createTestHarness();
    try {
      const llm = createOpenAiLlmClient({
        apiKey: process.env.OPENAI_API_KEY!,
        baseUrl: process.env.OPENAI_BASE_URL!,
        model: process.env.LLM_MODEL?.trim() || 'qwen3.8-flash',
        // 与生产同一口径：DEBUG=1 才落盘（排查「模型到底看到了什么」时用；不落 key）
        debugLogDir: process.env.DEBUG === '1' ? path.join(REPO_ROOT, 'data/logs') : undefined,
      });
      const slotId = `${harness.clock.now().toISOString().slice(0, 10)}:dinner`;

      const recommendation = await recommendMeal(harness.db, harness.clock, llm, slotId, {
        diners: ['mom', 'dad'],
      });

      const { structure } = recommendation;
      expect(recommendation.dishes).toHaveLength(structure.meat + structure.veg + structure.soup);
      expect(recommendation.dishes.every((dish) => (dish.reason ?? '').trim().length > 0)).toBe(true);
      // 不写死“一定不降级”：本机端点不支持 strict 时，strict 档会先失败再走 JSON 档，
      // 那也是**成功**的推荐（只是 degraded=true）。这里只守两档的自洽。
      expect(['json_schema', 'json_object']).toContain(recommendation.llm.format);
      expect(recommendation.llm.degraded).toBe(recommendation.llm.format !== 'json_schema');
      expect(recommendation.llm.latencyMs).toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  }, 90_000);
});
