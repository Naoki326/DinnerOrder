import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestHarness, type TestHarness } from './harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

describe('harness 隔离性', () => {
  it('每个 harness 拿到全新的内存库，互不见对方的数据', () => {
    const a = createTestHarness();
    const b = createTestHarness();
    try {
      a.db.exec('CREATE TABLE only_in_a (id INTEGER)');
      a.db.prepare('INSERT INTO only_in_a (id) VALUES (1)').run();

      const inA = a.db.prepare('SELECT COUNT(*) AS n FROM only_in_a').get() as { n: number };
      expect(inA.n).toBe(1);
      expect(() => b.db.prepare('SELECT COUNT(*) AS n FROM only_in_a').get()).toThrow(/no such table/);

      const tablesInB = b.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tablesInB).toEqual(['schema_migrations']);
    } finally {
      a.close();
      b.close();
    }
  });

  it('迁移记录也隔离：同一个迁移目录在两个 harness 里各自独立执行', () => {
    // 用临时目录注入一个真迁移，才能证明「各自独立执行」——两个空库的 0 === 0 证明不了任何事
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-migrations-'));
    try {
      fs.writeFileSync(path.join(dir, '001_probe.sql'), 'CREATE TABLE probe_isolation (id INTEGER);');

      const a = createTestHarness({ migrationsDir: dir });
      const b = createTestHarness({ migrationsDir: dir });
      try {
        // 两边都执行了同一个迁移，且各记一条
        expect(a.db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
          { version: '001', name: 'probe' },
        ]);
        expect(b.db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
          { version: '001', name: 'probe' },
        ]);

        // 关键：a 的表数据不会出现在 b 里（各自独立执行，不是共享一个库）
        a.db.prepare('INSERT INTO probe_isolation (id) VALUES (1)').run();
        const inB = b.db.prepare('SELECT COUNT(*) AS n FROM probe_isolation').get() as { n: number };
        expect(inB.n).toBe(0);
      } finally {
        a.close();
        b.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺省迁移目录为空时，harness 库里没有任何领域表', () => {
    const a = createTestHarness();
    try {
      expect(a.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
    } finally {
      a.close();
    }
  });

  it('close() 之后连接确实关掉', () => {
    const local = createTestHarness();
    local.close();
    expect(() => local.db.prepare('SELECT 1').get()).toThrow(/not open|closed/i);
  });
});

describe('注入的时钟可控', () => {
  it('默认固定起点，测试可拨动与推进', () => {
    harness = createTestHarness();
    expect(harness.clock.now().toISOString()).toBe('2025-06-01T10:00:00.000Z');

    harness.clock.set('2025-06-08T10:00:00.000Z');
    expect(harness.clock.now().toISOString()).toBe('2025-06-08T10:00:00.000Z');

    harness.clock.advance(14 * 24 * 60 * 60 * 1000); // 冷藏期 14 天
    expect(harness.clock.now().toISOString()).toBe('2025-06-22T10:00:00.000Z');
  });

  it('时钟值经 HTTP 可观测（注入真的贯通到请求处理）', async () => {
    harness = createTestHarness();
    harness.clock.set('2030-01-02T03:04:05.000Z');

    const { status, body } = await harness.json<{ serverTime: string }>('/api/health');
    expect(status).toBe(200);
    expect(body.serverTime).toBe('2030-01-02T03:04:05.000Z');
  });
});

describe('注入的 LLM fake', () => {
  it('默认无工具、调用即报错（不联网、不静默成功）', async () => {
    harness = createTestHarness();
    expect(harness.llm.listTools()).toEqual([]);
    await expect(harness.llm.callTool('anything', {})).rejects.toThrow(/未注册工具/);
    // 失败的调用照样记账（断言「LLM 被调用过几次」时不因失败而漏数）
    expect(harness.llm.calls).toEqual([{ name: 'anything', args: {} }]);
  });

  it('工具列表经 HTTP 暴露，且记录调用参数', async () => {
    harness = createTestHarness({
      llmTools: [
        { name: 'seasonal_ingredients', description: '某月时令食材', inputSchema: { type: 'object' } },
      ],
    });

    const { body } = await harness.json<{ llm: { tools: { name: string }[] } }>('/api/health');
    expect(body.llm.tools).toEqual([{ name: 'seasonal_ingredients', description: '某月时令食材' }]);

    const [result] = await Promise.all([harness.llm.callTool('seasonal_ingredients', { month: 6 })]);
    expect(result.isError).toBeUndefined();
    expect(harness.llm.calls).toEqual([{ name: 'seasonal_ingredients', args: { month: 6 } }]);
  });

  it('可编程序响应与编程序错误（覆盖降级路径用）', async () => {
    harness = createTestHarness({
      llmTools: [{ name: 'pick', description: '选菜', inputSchema: { type: 'object' } }],
    });
    harness.llm.setToolResult('pick', (args) => ({ content: JSON.stringify({ picked: args.from ?? [] }) }));
    expect(await harness.llm.callTool('pick', { from: ['a', 'b'] })).toEqual({
      content: JSON.stringify({ picked: ['a', 'b'] }),
    });

    harness.llm.setToolError('pick', new Error('模拟超时'));
    await expect(harness.llm.callTool('pick', {})).rejects.toThrow('模拟超时');

    // clearCalls 只清日志，编程响应仍在
    harness.llm.clearCalls();
    expect(harness.llm.calls).toEqual([]);
  });
});

describe('进程内直打 HTTP', () => {
  it('request() 走完整 Fetch 语义（状态码 + JSON）', async () => {
    harness = createTestHarness();
    const response = await harness.request('/api/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('未知路径返回 JSON 404，不落到前端 SPA fallback', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error: string }>('/api/nope');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('harness 不监听端口（app.request 是进程内直打）', async () => {
    harness = createTestHarness();
    // 未 listen 的 app 依然可请求，说明测试不依赖真实网络与端口
    const { status } = await harness.json('/api/health');
    expect(status).toBe(200);
  });
});

describe('basePath 注入贯通', () => {
  it('默认根路径：/api/health 可达', async () => {
    harness = createTestHarness();
    expect(harness.basePath).toBe('/');
    const { body } = await harness.json<{ basePath: string }>('/api/health');
    expect(body.basePath).toBe('/');
  });

  it('注入 /dinner：API 前缀随之，原根路径不再可达', async () => {
    harness = createTestHarness({ basePath: '/dinner/' });
    expect(harness.basePath).toBe('/dinner');

    const mounted = await harness.json<{ basePath: string }>('/dinner/api/health');
    expect(mounted.status).toBe(200);
    expect(mounted.body.basePath).toBe('/dinner');

    const unmounted = await harness.json('/api/health');
    expect(unmounted.status).toBe(404);
  });
});

describe('zod 校验通道', () => {
  it('合法参数通过并生效', async () => {
    harness = createTestHarness({
      llmTools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    });
    const { status, body } = await harness.json<{ llm: { tools: unknown[] } }>('/api/health?tools=0');
    expect(status).toBe(200);
    expect(body.llm.tools).toEqual([]);
  });

  it('非法参数返回 400（校验失败不进入 handler）', async () => {
    harness = createTestHarness();
    const { status } = await harness.json('/api/health?tools=yes');
    expect(status).toBe(400);
  });
});
