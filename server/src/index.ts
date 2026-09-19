import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { loadServerConfig } from './config.js';
import { ensureParentDir, openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createUnconfiguredLlmClient } from './llm/unconfigured.js';

/** 生产入口（launchd 直跑 `node server/dist/index.js`，spec §7） */
function main(): void {
  const config = loadServerConfig();

  ensureParentDir(config.dbPath);
  const db = openDatabase(config.dbPath);
  const { applied, alreadyApplied } = runMigrations(db, config.migrationsDir);
  if (applied.length > 0) {
    console.log(`[db] 已应用迁移：${applied.map((m) => m.version).join(', ')}（此前 ${alreadyApplied.length} 个）`);
  }

  const app = createApp({
    db,
    clock: systemClock,
    llm: createUnconfiguredLlmClient(),
    basePath: config.basePath,
    webDistDir: config.webDistDir,
  });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(
      `[server] 家餐桌 listening on http://${info.address}:${info.port} (BASE_PATH=${config.basePath}, DB=${config.dbPath})`,
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`[server] 收到 ${signal}，正在停止…`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
