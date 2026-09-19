import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createLlmClient } from './bootstrap.js';
import { systemClock } from './clock.js';
import { loadServerConfig, normalizeBasePath, resolveDevApiPort } from './config.js';
import { ensureParentDir, openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';

/**
 * 开发 API 进程：`pnpm dev` 由根目录并行拉起它（缺省 8788）与 Vite（5173）。
 * Vite 把 /api 代理到这里，所以本进程不服务静态产物（前端由 Vite 提供）。
 * 生产是单进程一体，见 index.ts。
 *
 * 端口刻意用独立的 DEV_API_PORT 而不是 PORT：宿主机/工具链常给进程注入 PORT，
 * 一旦被占用或劫持，Vite 的代理目标就会悄悄指错地方（表现为「前端打得开、API 全挂」）。
 * 缺省值与空串口径由 config.resolveDevApiPort 统一，Vite 侧读同一个变量。
 */
const config = loadServerConfig({
  ...process.env,
  PORT: String(resolveDevApiPort()),
  BASE_PATH: process.env.BASE_PATH,
  DB_PATH: process.env.DB_PATH ?? 'data/dinner.dev.db',
});

ensureParentDir(config.dbPath);
const db = openDatabase(config.dbPath);
runMigrations(db, config.migrationsDir);

const app = createApp({
  db,
  clock: systemClock,
  // 与生产同一份选择规则（bootstrap.createLlmClient）：配了 .env 就是真调用。
  // 开发时不配也照跑——推荐降级成简化推荐，其余功能不受影响。
  llm: createLlmClient(),
  basePath: config.basePath,
  // 刻意不传 webDistDir：开发时前端由 Vite 提供，避免误服过期构建产物
});

const apiPath = `${normalizeBasePath(config.basePath) === '/' ? '' : config.basePath}/api/health`;
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) => {
  console.log(`[dev:api] http://127.0.0.1:${info.port}${apiPath}`);
  console.log('[dev:api] 前端请在浏览器打开 http://127.0.0.1:5173（Vite，已代理 /api）');
});

const shutdown = (): void => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
