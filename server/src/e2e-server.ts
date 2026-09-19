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
 *
 * `E2E_CLOCK_CONTROL=1`：让本进程接受 `PUT /api/e2e/clock`（body `{ offsetMs }`）拨动时钟，
 * `DELETE /api/e2e/clock` 复位。**S6 的转正门槛（「上桌过」= 过了餐次截止时刻）靠它才可测**：
 * 真实时钟下 E2E 没法把一餐推到「已经吃过」——定餐接口拒收已过截止的餐槽（`slot_passed`），
 * 等真时间过去又不可能。所以这个 seam **只存在于 E2E 服务端**：生产入口（`index.ts`）
 * 直接 `bootstrap()`，既没有这个开关、也没有这个路由（见 `test-e2e` 与 `playwright.config.ts`
 * 里只有第一个 webServer 设 `E2E_CLOCK_CONTROL=1`）。
 *
 * 为什么用自定义 fetch 包装而不是挂一条 Hono 路由：`createApp()` 在业务路由之后注册了
 * `/api/*` 的 JSON 404 兜底（顺序敏感），事后 `app.route(...)` 挂上去的路由会被它截胡。
 * 包装在 `serve({ fetch })` 这一层则完全在 HTTP 入口、不碰路由表——E2E 的控制口不该混进
 * 生产 app 的形状里。
 */
import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap.js';
import type { Clock } from './clock.js';
import { joinBase } from './config.js';
import { createFakeLlmClient } from './llm/fake.js';
import { pickLlmSelection } from './llm/prompt.js';
import { pickPromotionRewrite } from './llm/promotion-schema.js';

const llm = createFakeLlmClient();
llm.setModel('e2e-fake-llm');

if (process.env.E2E_LLM_MODE === 'fail') {
  // 降级链会换档重试两次，这里每次调用都失败 → 最终落到简化推荐
  const fail = (): never => {
    throw new Error('E2E_LLM_MODE=fail：模拟端点不可达');
  };
  llm.setCompletion(fail);
} else {
  // 同一个确定性 fake 同时支持三条路：转正改写（【待转正菜谱】）、整餐推荐（【候选池】）
  // 与换菜候选（【同位候选池】）。转正放在最前：它的 prompt 标记是唯一不会与另两条重叠的。
  llm.setCompletion((request) => pickPromotionRewrite(request.prompt) ?? pickLlmSelection(request.prompt) ?? '{"dishes":[]}');
}

/** 可拨动的时钟：`offsetMs` 加到系统时刻上。E2E 只调它来「让时间走过去」。 */
function createOffsetClock(): { clock: Clock; setOffset(ms: number): void; offsetMs(): number } {
  let offsetMs = 0;
  return {
    clock: { now: () => new Date(Date.now() + offsetMs) },
    setOffset(ms) {
      offsetMs = ms;
    },
    offsetMs() {
      return offsetMs;
    },
  };
}

const clockControl = process.env.E2E_CLOCK_CONTROL === '1';
const offset = createOffsetClock();

const { config, db, app, applied } = bootstrap({
  env: process.env,
  llm,
  ...(clockControl ? { clock: offset.clock } : {}),
});

if (applied.length > 0) {
  console.log(`[e2e:db] 已应用迁移：${applied.join(', ')}`);
}

/** 时钟控制口（仅 `E2E_CLOCK_CONTROL=1` 时生效）；返回 undefined = 这条请求不归它管 */
async function clockControlResponse(request: Request): Promise<Response | undefined> {
  if (!clockControl) return undefined;
  const url = new URL(request.url);
  // 挂载前缀跟随服务端配置（与其它 API 同一口径）：子路径部署下控制口也在子路径里
  if (url.pathname !== joinBase(config.basePath, '/api/e2e/clock')) return undefined;

  if (request.method === 'GET') {
    return Response.json({ offsetMs: offset.offsetMs() });
  }
  if (request.method === 'PUT') {
    let body: { offsetMs?: unknown };
    try {
      body = (await request.json()) as { offsetMs?: unknown };
    } catch {
      return Response.json({ error: 'invalid_request', issues: [{ path: 'offsetMs', message: '要 JSON body' }] }, { status: 400 });
    }
    const value = Number(body.offsetMs);
    if (!Number.isFinite(value)) {
      return Response.json(
        { error: 'invalid_request', issues: [{ path: 'offsetMs', message: 'offsetMs 必须是数字（毫秒）' }] },
        { status: 400 },
      );
    }
    offset.setOffset(value);
    return Response.json({ offsetMs: value, now: offset.clock.now().toISOString() });
  }
  if (request.method === 'DELETE') {
    offset.setOffset(0);
    return Response.json({ offsetMs: 0, now: offset.clock.now().toISOString() });
  }
  return Response.json({ error: 'not_found', path: url.pathname }, { status: 404 });
}

const server = serve(
  {
    fetch: async (request: Request): Promise<Response> => (await clockControlResponse(request)) ?? app.fetch(request),
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(`[e2e] listening on http://${info.address}:${info.port} (BASE_PATH=${config.basePath})`);
  },
);

const shutdown = (): void => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
