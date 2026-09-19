import { defineConfig, devices } from '@playwright/test';
import { E2E, ROOT_URL } from './e2e/test-env';

/**
 * 本机开发环境里 HTTP_PROXY/HTTPS_PROXY 指向本地代理（Clash 一类），Playwright 探测 webServer
 * 是否已就绪时会被代理截胡，报「port already used」。这里在 runner 进程内把本机地址排除出代理，
 * 使 `pnpm test:e2e` 在任何代理配置下都稳定。
 */
process.env.NO_PROXY = `127.0.0.1,localhost,${process.env.NO_PROXY ?? ''}`.replace(/,$/, '');
process.env.no_proxy = process.env.NO_PROXY;

/**
 * 冒烟 E2E：手机尺寸浏览器打开首页看到 app 壳空态。
 *
 * 两个 webServer 实例都是**真正的单进程一体**（`node server/dist/index.js`，API + 前端产物同一进程），
 * 区别只在 BASE_PATH：一个根路径、一个子路径——同一份构建产物，验证 ADR-0003 的运行时注入。
 * LLM 不参与：骨架路径上没有任何 LLM 调用（真调用留给 #17）。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    viewport: E2E.viewport,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: E2E.viewport } }],
  webServer: [
    {
      command: 'node server/dist/index.js',
      url: `${ROOT_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(E2E.root.port),
        HOST: '127.0.0.1',
        BASE_PATH: E2E.root.basePath,
        DB_PATH: 'data/e2e-root.db',
        WEB_DIST_DIR: 'web/dist',
      },
    },
    {
      command: 'node server/dist/index.js',
      url: `http://127.0.0.1:${E2E.subPath.port}${E2E.subPath.basePath}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(E2E.subPath.port),
        HOST: '127.0.0.1',
        BASE_PATH: E2E.subPath.basePath,
        DB_PATH: 'data/e2e-sub.db',
        WEB_DIST_DIR: 'web/dist',
      },
    },
  ],
});
