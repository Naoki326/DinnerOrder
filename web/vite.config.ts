import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const webDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(webDir, '..');

// 资产一律相对引用（ADR-0003）：同一构建产物挂 / 或 /dinner/ 都无需重打包。
export default defineConfig(({ mode }) => {
  /**
   * 开发 API 端口必须与 `server/src/dev.ts` 的端口一致，否则代理悄悄指错地方
   * （表现为「前端打得开、API 全挂」）。两边读**同一份**仓库根 `.env`：
   * API 侧由 `--env-file-if-exists=../.env` 加载，这里用 loadEnv 显式指向根目录——
   * 不能依赖 Vite 默认的 envDir（那是 web/），根 `.env` 里的值读不到。
   *
   * 缺省值与空串口径与 server 侧 config.resolveDevApiPort 一致（8788），
   * `.env` 里写个空值时必须同样回落到 8788，不能一边 8788 一边 8787。
   */
  const rootEnv = loadEnv(mode, repoRoot, '');
  const apiPort = (rootEnv.DEV_API_PORT || process.env.DEV_API_PORT || '').trim() || '8788';

  return {
    base: './',
    plugins: [react()],
    build: {
      // 输出到 web/dist；生产入口以 serveStatic 指向这里
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        // 开发时前端直连 API dev server（生产是单进程一体，无代理）
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: false,
        },
      },
    },
  };
});
