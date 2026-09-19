import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps } from './app.js';

/**
 * 前端 index.html 里由服务端替换的注入点（必须与 web/index.html 保持一致）。
 * 它是一个 JS 行内注释，写在一个 `<script>` 标签内部：
 *
 *   <script>/*__APP_CONFIG__*\/</script>
 *
 * 所以这里只替换成「赋值语句」本身，不再包一层 script 标签（否则会嵌出非法 HTML）。
 */
export const APP_CONFIG_MARKER = '/*__APP_CONFIG__*/';

export interface AppConfigPayload {
  basePath: string;
}

/**
 * 运行时注入配置（ADR-0003）：同一份构建产物挂 '/' 或 '/dinner/' 都不重打包，
 * 路径真相由服务端的 BASE_PATH 决定，页面里的 window.__APP_CONFIG__ 是前端唯一来源。
 */
export function renderAppConfigScript(basePath: string): string {
  const payload: AppConfigPayload = { basePath };
  // 转义 `<`，防止值里出现 `</script>` 提前闭合脚本标签
  return `window.__APP_CONFIG__=${JSON.stringify(payload).replace(/</g, '\\u003c')};`;
}

export function renderIndexHtml(source: string, basePath: string): string {
  if (!source.includes(APP_CONFIG_MARKER)) {
    throw new Error(`index.html 缺少注入标记 ${APP_CONFIG_MARKER}：前端产物与服务端约定不一致`);
  }
  // 注入 JSON 时转义 `<`，防止值里出现 `</script>` 提前闭合脚本标签
  const injected = source.replace(APP_CONFIG_MARKER, renderAppConfigScript(basePath));
  return injectBaseHref(injected, basePath);
}

/**
 * 把 `<base href>` 插进 head：这是**深链**能正常加载资源的前提。
 *
 * 资产是相对引用（`./assets/x.js`，ADR-0003），相对谁解析由**当前页面的 URL 决定**：
 * 挂在 `/` 时 `/slot/2025-06-01:dinner` 会把 `./assets/x.js` 解析成
 * `/slot/assets/x.js` —— 深链一刷新就白屏（浏览器拿不到 JS/CSS，页面连报错的机会都没有）。
 * `<base href="${basePath}/">` 把「相对谁」固定到挂载点，资产引用保持相对、无需重打包。
 */
function injectBaseHref(html: string, basePath: string): string {
  const raw = basePath === '/' ? '/' : `${basePath}/`;
  // 属性值转义：basePath 是启动配置，但这个字符串最终落进 HTML 属性，转义是零成本的自保
  const href = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tag = `<base href="${href}" />`;
  // 产物里不该已经有 base：两份 base 的生效规则（取第一个）会让改动看起来「没生效」
  if (/<base\s/i.test(html)) return html;
  if (!/<head[\s>]/i.test(html)) {
    throw new Error('index.html 里找不到 <head>，没法注入 <base href>（深链会加载不到相对资产）');
  }
  return html.replace(/<head([\s>])/i, `<head$1${tag}`);
}

/** PWA manifest 的 start_url / scope 同样从 BASE_PATH 推导（挂在子路径时可安到主屏仍指向正确位置） */
export function renderManifest(source: string, basePath: string): string {
  const manifest = JSON.parse(source) as Record<string, unknown>;
  const scope = basePath === '/' ? './' : `${basePath}/`;
  manifest['scope'] = scope;
  manifest['start_url'] = scope;
  return JSON.stringify(manifest, null, 2);
}

function readAsset(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 静态资源中间件：把 `${basePath}/assets/x.js` 映射到构建产物里的 `assets/x.js` */
export function createStaticMiddleware(webDistDir: string, basePath: string): MiddlewareHandler {
  return serveStatic({
    root: webDistDir,
    rewriteRequestPath: (requestPath) => {
      if (basePath === '/') return requestPath;
      return requestPath.startsWith(basePath) ? requestPath.slice(basePath.length) || '/' : requestPath;
    },
    onNotFound: (_requestPath, c) => {
      c.header('Cache-Control', 'no-store');
    },
  });
}

export function createIndexHandler(webDistDir: string, deps: Pick<AppDeps, 'basePath'>): (c: Context) => Response {
  return (c) => {
    const source = readAsset(path.join(webDistDir, 'index.html'));
    if (source === null) {
      return c.json(
        { error: 'web_dist_missing', hint: `找不到 ${path.join(webDistDir, 'index.html')}，请先 pnpm build:web` },
        503,
      );
    }
    return c.html(renderIndexHtml(source, deps.basePath), 200, {
      // 注入过 basePath 的 HTML 不能长缓存，否则换挂载点后老页面会请求错路径
      'Cache-Control': 'no-store',
    });
  };
}

export function createManifestHandler(webDistDir: string, deps: Pick<AppDeps, 'basePath'>): (c: Context) => Response {
  return (c) => {
    const source = readAsset(path.join(webDistDir, 'manifest.webmanifest'));
    if (source === null) {
      return c.json({ error: 'manifest_missing' }, 404);
    }
    return c.body(renderManifest(source, deps.basePath), 200, {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-store',
    });
  };
}
