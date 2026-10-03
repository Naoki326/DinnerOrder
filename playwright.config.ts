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
  projects: [
    // #31：版式是设备本地偏好，判据是视口宽度——所以「同一份构建产物在两种尺寸下」
    // 用两个 project 跑。`phone` 跑全部（既有 95 条断言的归属地）；`tablet` 只跑与版式
    // 直接相关的那些文件（issue 明写这可以白名单，别假定宽版能跑通全部）。
    //
    // 白名单**刻意不含 `recipe-library.spec.ts`**：它的「录入一道新菜」用例会往**两个 project
    // 共用的库**里建一道固定名字的菜，第二个 project 再跑时 `findNewRecipe` 按名字会先找到
    // 上一个 project 留下的那道（`recipe-form-<新 id>` 于是永远不出现）——是**跨 project 的
    // 测试干扰**，不是版式问题。菜谱库的宽版摆法由 `tablet.spec.ts` 的两条直接覆盖
    // （「菜谱库在平板版下不显示主导航」+「逐页冒烟」里的双列与搜索入口），更对口。
    //
    // `ingredients.spec.ts`（#34）**在白名单里**：它的每条用例都在 `afterEach` 里用删除功能
    // 清掉自己新建的条目（零引用，删得掉），两个 project 顺序跑不会互相干扰——而入口路径
    // 的两种版式正是本票 AC 点名的，需要真在平板上跑一次。
    //
    // `recipe-editor-create-ingredient.spec.ts`（#36）**也在白名单里**：它按 spec #33 的
    // Testing Decisions「两版式：手机与平板各跑一次入口路径」而写，且**名字带 project 后缀**
    // （`uniqueSuffix` 含 `test.info().project.name`）——不会有 `recipe-library.spec.ts` 那种
    // 「固定名字跨 project 命中上一轮」的干扰。
    //
    // `nutrition-estimate.spec.ts`（#38）**也在白名单里**：issue 的 AC 明写「手机 / 平板两版式都能用」
    // （四项营养的录入表单最容易在窄屏上吃穿），且它同样**名字带 project 后缀 + 自己清场**。
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: E2E.viewport } },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: E2E.tabletViewport },
      testMatch: /(tablet|views|smoke|review|ingredients|recipe-editor-create-ingredient|nutrition-estimate)\.spec\.ts/,
    },
  ],
  webServer: [
    {
      // 先删掉上一轮留下的库：E2E 会改画像（增删忌口/改出生年月），
      // 带脏库启动会让断言看着种子、实际是上次的残留。两个实例各删各的库，互不影响。
      // `*.db*` 一并覆盖 -wal/-shm（WAL 侧文件不删，新库会看到旧日记）。
      command: 'rm -f data/e2e-root.db* && node server/dist/e2e-server.js',
      url: `${ROOT_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(E2E.root.port),
        HOST: '127.0.0.1',
        BASE_PATH: E2E.root.basePath,
        DB_PATH: 'data/e2e-root.db',
        WEB_DIST_DIR: 'web/dist',
        // E2E 一律用确定性 fake LLM（服务端入口自己注入）：不联网、不随模型变
        // 只有根路径这一个实例开时钟控制口（S6 转正需要把一餐推到「已经吃过」）：
        // 控制口是测试专用 seam，其余实例与生产入口一样没有它
        E2E_CLOCK_CONTROL: '1',
      },
    },
    {
      command: 'rm -f data/e2e-sub.db* && node server/dist/e2e-server.js',
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
    {
      // S7 专用：同一个服务端，只把 LLM 换成「每次都失败」，验降级到简化推荐后的界面表现。
      // 单独开一个实例而不是让主实例可切模式：那会让其他用例的断言依赖执行顺序。
      command: 'rm -f data/e2e-llm-down.db* && node server/dist/e2e-server.js',
      url: `http://127.0.0.1:${E2E.llmDown.port}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(E2E.llmDown.port),
        HOST: '127.0.0.1',
        BASE_PATH: E2E.llmDown.basePath,
        DB_PATH: 'data/e2e-llm-down.db',
        WEB_DIST_DIR: 'web/dist',
        E2E_LLM_MODE: 'fail',
      },
    },
  ],
});
