import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap.js';

/**
 * 生产入口（launchd 直跑 `node server/dist/index.js`，spec §7）。
 * 库、迁移、LLM 客户端与 app 的装配在 `bootstrap()`（与 E2E 共用一份）；
 * 这里只管：listen、打印一条启动行、把信号转成优雅停机。
 */
function main(): void {
  const { config, db, llm, app, applied, alreadyApplied } = bootstrap();
  if (applied.length > 0) {
    console.log(`[db] 已应用迁移：${applied.join(', ')}（此前 ${alreadyApplied} 个）`);
  }

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(
      `[server] 家餐桌 listening on http://${info.address}:${info.port} (BASE_PATH=${config.basePath}, DB=${config.dbPath}, LLM=${llm.model})`,
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
