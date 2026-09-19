/**
 * E2E 专用服务端入口：与生产入口同一条装配路（`bootstrap()`），只把 LLM 换成**确定性 fake**。
 *
 * 为什么不让 E2E 打真 LLM：真调用不确定（同一 prompt 两次给不同的菜）、要网、要钱，
 * 断言只能写成「有几道菜」这种弱命题；而 E2E 要验的是**管线本身**（规则过滤 / 结构 /
 * 一键接受 / 留痕元数据），那些不需要真模型。fake 会解析 prompt 里的【候选池】与【本餐结构】
 * 做一次合法选择——所以「池子过滤对了没有」这件事在 E2E 里也真的被验了。
 *
 * 用法：`node server/dist/e2e-server.js`（由 playwright.config.ts 的 webServer 拉起）。
 * 环境变量与生产完全一致（PORT/BASE_PATH/DB_PATH/WEB_DIST_DIR）。
 *
 * `E2E_LLM_MODE=fail`：让 LLM 每次都失败（抛错），用于验 S7 的降级路径——
 * 「断网/超时/schema 连败后界面给出简化推荐并显著标记」。生产入口没有这个开关。
 */
import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap.js';
import { createFakeLlmClient } from './llm/fake.js';
import { pickPoolSelection } from './llm/prompt.js';

const llm = createFakeLlmClient();
llm.setModel('e2e-fake-llm');

if (process.env.E2E_LLM_MODE === 'fail') {
  // 降级链会换档重试两次，这里每次调用都失败 → 最终落到简化推荐
  const fail = (): never => {
    throw new Error('E2E_LLM_MODE=fail：模拟端点不可达');
  };
  llm.setCompletion(fail);
} else {
  llm.setCompletion((request) => pickPoolSelection(request.prompt) ?? '{"dishes":[]}');
}

const { config, db, app, applied } = bootstrap({ env: process.env, llm });

if (applied.length > 0) {
  console.log(`[e2e:db] 已应用迁移：${applied.join(', ')}`);
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[e2e] listening on http://${info.address}:${info.port} (BASE_PATH=${config.basePath})`);
});

const shutdown = (): void => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
