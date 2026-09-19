import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createTestClock } from './testing/harness.js';
import { createFakeLlmClient } from './llm/fake.js';
import { openDatabase } from './db/index.js';

let server: ServerType | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/**
 * 真的监听一个端口再打（其余测试用 app.request 进程内直打即可）。
 * 这条只为证明「一个 Node 进程同时服务 API 与前端静态产物」在真实 HTTP 下成立。
 */
describe('单进程一体的真实 HTTP', () => {
  it('同一个端口上 API 与静态产物都可用', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-serve-'));
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<html><head><script>/*__APP_CONFIG__*/</script></head><body>壳</body></html>',
      'utf8',
    );

    const db = openDatabase(':memory:');
    const clock = createTestClock('2025-06-01T10:00:00.000Z');
    const app = createApp({
      db,
      clock,
      llm: createFakeLlmClient(),
      basePath: '/dinner',
      webDistDir: tmpDir,
    });

    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server!.on('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/dinner/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, basePath: '/dinner' });

    const index = await fetch(`${base}/dinner/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('window.__APP_CONFIG__={"basePath":"/dinner"};');

    db.close();
  });
});
