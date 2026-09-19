import { Hono } from 'hono';
import type { Clock } from './clock.js';
import { joinBase } from './config.js';
import type { Db } from './db/index.js';
import type { LlmClient } from './llm/types.js';
import { registerHealthRoutes } from './api/health.js';
import { registerIngredientRoutes } from './api/ingredients.js';
import { registerMemberRoutes } from './api/members.js';
import { registerPortionRoutes } from './api/portion.js';
import { registerRecommendationRoutes } from './api/recommendations.js';
import { registerReplacementRoutes } from './api/replacements.js';
import { registerRecipeRoutes } from './api/recipes.js';
import { registerSlotRoutes } from './api/slots.js';
import { createIndexHandler, createManifestHandler, createStaticMiddleware } from './static.js';

/** 路径末段看起来是文件（带扩展名）——SPA fallback 不该给它返回 HTML */
function looksLikeFile(requestPath: string): boolean {
  const lastSegment = requestPath.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

/** 路由层能用到的一切外部依赖——全部注入，测试里可整体替换 */
export interface AppDeps {
  db: Db;
  clock: Clock;
  llm: LlmClient;
  /** 归一化后的挂载前缀（'/' 或 '/dinner'） */
  basePath: string;
}

export interface AppOptions extends AppDeps {
  /**
   * 前端构建产物目录（单进程一体的静态侧）。不传或目录不存在时只服务 API——
   * 开发模式下前端由 Vite dev server 提供（它把 /api 代理到这里）。
   */
  webDistDir?: string;
}

/**
 * 组装 app：不 listen、不读环境变量、不碰文件系统以外的全局状态。
 * 这就是后续所有工单的测试 seam——`createTestHarness()` 用进程内 `app.request()` 直打它。
 */
export function createApp(options: AppOptions): Hono {
  const { basePath, webDistDir } = options;
  const app = new Hono();

  const api = new Hono();
  registerHealthRoutes(api, options);
  registerIngredientRoutes(api, options);
  registerMemberRoutes(api, options);
  registerPortionRoutes(api, options);
  registerRecommendationRoutes(api, options);
  registerReplacementRoutes(api, options);
  registerRecipeRoutes(api, options);
  registerSlotRoutes(api, options);
  app.route(joinBase(basePath, '/api'), api);
  // API 未匹配 → JSON 404（不能落到前端的 SPA fallback，否则前端会拿 HTML 去 parse）
  app.all(joinBase(basePath, '/api/*'), (c) => c.json({ error: 'not_found', path: c.req.path }, 404));

  if (basePath !== '/') {
    // 子路径下无尾斜杠会让 './assets/...' 解析到父级路径；重定向到带斜杠形态
    app.get(basePath, (c) => c.redirect(`${basePath}/`, 302));
  }

  if (webDistDir) {
    const indexHandler = createIndexHandler(webDistDir, options);
    app.get(joinBase(basePath, '/'), indexHandler);
    app.get(joinBase(basePath, '/index.html'), indexHandler);
    app.get(joinBase(basePath, '/manifest.webmanifest'), createManifestHandler(webDistDir, options));
    app.use(joinBase(basePath, '/*'), createStaticMiddleware(webDistDir, basePath));
    // 其余 GET：带扩展名的按「缺失的文件」处理，返回 404 而不是 index.html。
    // 否则浏览器拿 HTML 当 JS/CSS 解析，报的是「MIME type 不对」这种与真因无关的错。
    // 不带扩展名的当作前端深链（未来的 /买菜 之类路由）交给 Router，返回 index.html。
    app.get(joinBase(basePath, '/*'), (c) =>
      looksLikeFile(c.req.path) ? c.text('Not Found', 404) : indexHandler(c),
    );
  } else {
    app.get(joinBase(basePath, '/'), (c) =>
      c.json({ ok: true, mode: 'api-only', hint: '未配置 WEB_DIST_DIR：开发模式请开 Vite dev server（5173）' }),
    );
  }

  app.notFound((c) => {
    if (basePath !== '/' && !c.req.path.startsWith(`${basePath}/`) && c.req.path !== basePath) {
      return c.json({ error: 'not_found', hint: `本服务挂载在 ${basePath}/，请求路径在其之外：${c.req.path}` }, 404);
    }
    return c.json({ error: 'not_found', path: c.req.path }, 404);
  });

  return app;
}
