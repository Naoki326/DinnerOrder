/**
 * 运行时配置（ADR-0003）：basePath 的唯一来源是服务端注入的 window.__APP_CONFIG__。
 * 同一构建产物挂 '/' 或 '/dinner/' 都不重打包。
 */
export interface AppConfig {
  basePath: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: Partial<AppConfig>;
  }
}

/**
 * 归一化 basePath：容错缺前导斜杠、多余斜杠与尾斜杠，以及 `.`/`./`（都指根）。
 *
 * 这里**不做**合法性拒收（查询串/错点/`..` 由服务端 `server/src/config.ts` 的
 * normalizeBasePath 在启动时就把关，值本身也由服务端注入）；本函数的职责只是把
 * 已经可信的值归一到前端能直接用的形态。`/` 与 `.`/`./` 的归一化语义两边保持一致。
 */
export function normalizeBasePath(input: string | undefined | null): string {
  const raw = (input ?? '').trim();
  if (raw === '' || raw === '/' || raw === '.' || raw === './') return '/';
  const collapsed = (raw.startsWith('/') ? raw : `/${raw}`).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed === '' ? '/' : collapsed;
}

const injected = typeof window === 'undefined' ? undefined : window.__APP_CONFIG__?.basePath;

/**
 * basePath 的唯一真相：服务端按 BASE_PATH 注入的值（ADR-0003）。
 *
 * 注入缺失只在一种情况下发生：直接跑 Vite dev server（无服务端注入）。此时开发服务器把前端挂在
 * '/'，所以回退到根路径——刻意**不**读 import.meta.env.BASE_URL：Vite 的 base:'./' 会把它编译成
 * './'，当成路径前缀用会得到 basename '/.' 这种错值（实测会让 Router 一个都不匹配、页面空白）。
 */
export const basePath: string = normalizeBasePath(injected ?? '/');

/** API 前缀：挂在子路径时 `/dinner/api`，否则 `/api` */
export const apiBaseUrl: string = basePath === '/' ? '/api' : `${basePath}/api`;

/** react-router 的 basename：根路径用 '/'，子路径用 '/dinner' */
export const routerBasename: string = basePath;

export function apiUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(`${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}
