import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根目录。本文件在开发/测试时位于 `server/src/`、构建后位于 `server/dist/`，
 * 两者向上一级都是 `server/`，再向上一级即仓库根——所以从模块自身定位，
 * 无论从哪个目录启动进程，默认路径都不会漂移。
 */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * BASE_PATH 归一化（ADR-0003）。
 *
 * 非法输入（查询串/锚点/`..`）直接抛错，而不是悄悄降级成 '/'——部署时 `BASE_PATH=/dinner/` 写错一个字符
 * 会表现为「页面能开但 API 全 404」，静默兜底会让这种问题极难排查。
 * `.`/`./` 与空值等价（都指「根」），与 web 侧 normalizeBasePath 保持同一语义。
 */
export function normalizeBasePath(input: string | undefined | null): string {
  const raw = (input ?? '').trim();
  if (raw === '' || raw === '/' || raw === '.' || raw === './') return '/';

  // 容错两类无歧义写法：缺前导斜杠（BASE_PATH=dinner）、多余重复/尾斜杠
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;

  if (withLeadingSlash.includes('?') || withLeadingSlash.includes('#')) {
    throw new Error(`BASE_PATH 不能带查询串或锚点，收到：${JSON.stringify(input)}`);
  }

  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (collapsed === '') return '/';
  if (collapsed.split('/').includes('..')) {
    throw new Error(`BASE_PATH 不能含 '..'，收到：${JSON.stringify(input)}`);
  }
  return collapsed;
}

/** 把 app 内相对路径拼到 basePath 上：joinBase('/dinner', '/api/health') → '/dinner/api/health' */
export function joinBase(basePath: string, relativePath: string): string {
  const rel = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return basePath === '/' ? rel : `${basePath}${rel}`;
}

export interface ServerConfig {
  /** 归一化后的挂载前缀，'/' 或 '/dinner' 这类值 */
  basePath: string;
  host: string;
  port: number;
  /** 生产入口打开的 SQLite 文件；测试一律用内存库，不走这里 */
  dbPath: string;
  /** 前端构建产物目录；不存在时只服务 API（开发模式下由 Vite 服务前端） */
  webDistDir: string;
  migrationsDir: string;
}

function resolveDir(value: string | undefined, fallback: string, root: string): string {
  return path.resolve(root, value && value.trim() !== '' ? value : fallback);
}

/**
 * 开发 API 端口（`pnpm dev` 里 API 进程与 Vite 代理目标共用）。
 *
 * 空串/空白视为**未配置**而非「端口 0」：`.env` 里写个 `DEV_API_PORT=` 时，
 * 两侧都必须回落到同一个缺省值，否则又变回「前端打得开、API 全挂」那个坑。
 */
export function resolveDevApiPort(env: NodeJS.ProcessEnv = process.env, fallback = 8788): number {
  const raw = env.DEV_API_PORT?.trim();
  if (!raw) return fallback;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DEV_API_PORT 必须是 1-65535 的整数，收到：${JSON.stringify(env.DEV_API_PORT)}`);
  }
  return port;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, root = REPO_ROOT): ServerConfig {
  const portRaw = env.PORT?.trim();
  const port = portRaw ? Number.parseInt(portRaw, 10) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1-65535 的整数，收到：${JSON.stringify(env.PORT)}`);
  }

  return {
    basePath: normalizeBasePath(env.BASE_PATH),
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    dbPath: path.resolve(root, env.DB_PATH?.trim() || 'data/dinner.db'),
    // 前端产物在 web 包内：单进程一体时由本进程 serveStatic
    webDistDir: resolveDir(env.WEB_DIST_DIR, 'web/dist', root),
    migrationsDir: resolveDir(env.MIGRATIONS_DIR, 'server/migrations', root),
  };
}
