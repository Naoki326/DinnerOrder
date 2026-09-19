# 家餐桌（DinnerOrder）

自家用的家常菜预定与买菜助手：家人在手机上按餐槽预定今天的菜，系统按家人画像生成菜与量的推荐，
掌勺者拿到汇总买菜清单。**手机优先的网页端、单进程前后端一体、仅内网使用。**

需求与决策见 [`docs/spec/implementation-spec.md`](docs/spec/implementation-spec.md)、词汇见 [`CONTEXT.md`](CONTEXT.md)、
架构取舍见 [`docs/adr/`](docs/adr/)。

## 环境要求

- Node **≥ 22.12**（本机开发在 v22.22.2 上验证）
- pnpm（`corepack enable pnpm`；`packageManager` 已锁 12.4.2）
- 首次拉 E2E 浏览器：`pnpm exec playwright install chromium`

## 常用命令

在仓库根执行：

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 装依赖（workspace 已配 `allowBuilds`，只放行 better-sqlite3 / esbuild 的构建脚本） |
| `pnpm dev` | **一条命令起开发环境**：server API（8788，tsx watch）+ web（Vite 5173，已代理 `/api`）。浏览器开 http://127.0.0.1:5173 |
| `pnpm build` | 构建两端：`server/dist`（tsc）与 `web/dist`（vite build） |
| `pnpm start` | **生产单进程**：`node server/dist/index.js`，一个进程同时服务 API 与 `web/dist` 静态产物（默认 `0.0.0.0:8787`） |
| `pnpm typecheck` | 根 tsconfig（e2e/config）+ 两个包的 `tsc --noEmit` |
| `pnpm lint` | ESLint 9 flat config（typescript-eslint） |
| `pnpm test` | server 单测 + API 集成测试（Vitest，内存 SQLite） |
| `pnpm test:watch` | 同上，watch 模式 |
| `pnpm test:e2e` | 先 `build` 再跑 Playwright 冒烟（根路径 + 子路径两个实例） |

## 运行时配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_PATH` | `/` | 挂载前缀（ADR-0003）。`/dinner/` 与 `/dinner` 等价；非法值（带查询串/`..`）直接启动失败而非静默兜底 |
| `PORT` | `8787` | 生产监听端口 |
| `HOST` | `0.0.0.0` | 生产监听地址 |
| `DB_PATH` | `data/dinner.db` | SQLite 文件（开发模式默认 `data/dinner.dev.db`） |
| `WEB_DIST_DIR` | `web/dist` | 前端构建产物目录 |
| `MIGRATIONS_DIR` | `server/migrations` | 迁移 SQL 目录 |
| `DEV_API_PORT` | `8788` | 开发 API 端口（与 Vite 代理目标共用此变量） |

`.env` 在仓库根（**已被 `.gitignore` 排除，绝不入库**），由 `server/src/dev.ts` / 生产入口经
`--env-file-if-exists` 加载；真实 shell 环境变量优先级高于文件。密钥不打印、不进日志。

## 仓库结构

```
server/                 @dinnerorder/server —— Hono + better-sqlite3 + 领域逻辑
  src/app.ts            createApp()：组装 app（注入 db/clock/llm/basePath），不 listen
  src/index.ts          生产入口（单进程一体）
  src/dev.ts            开发 API 进程（只服务 API，前端交给 Vite）
  src/config.ts         BASE_PATH 归一化 + 环境变量装载
  src/static.ts         index.html 注入 window.__APP_CONFIG__ / manifest 改写 / serveStatic
  src/db/               openDatabase + 迁移执行器（编号 .sql，事务化，失败回滚）
  src/llm/              MCP 形状的 LLM seam：types / fake（测试用）/ unconfigured（生产占位）
  src/testing/harness.ts 集成测试 harness（内存库 + 可控时钟 + fake LLM + 直打 HTTP）
  src/domain/            领域逻辑（食材字典、家人画像）
  migrations/            编号 .sql（001 = 家人与食材字典，含种子；随库执行）
web/                    @dinnerorder/web —— React 18 + Vite + Router 7 + TanStack Query
  src/identity.tsx      当前身份（设备本地：localStorage；家人画像在服务端）
e2e/                    Playwright 冒烟 + 家人与当前身份
```

## API（M1 增量，无登录 · 家庭 Wi-Fi 即门禁）

| 路由 | 作用 |
| --- | --- |
| `GET /api/health` | 冒烟：时钟/LLM/basePath 的注入证明 |
| `GET /api/ingredients?q=` | 食材字典（规范名 + 别名；`q` 两者都匹配） |
| `GET /api/members` · `GET /api/members/:id` | 家人画像（大人/小孩、性别、出生年月、忌口、爱吃） |
| `PATCH /api/members/:id` | 改画像：`birthMonth` / `avoid[]` / `loves[]`，传了的块整体替换 |

**错误响应形状统一为 `{error: '<代码>'}`**（可能附指认字段，如 `unknown_ingredient` 带 `ingredientId`）。
入参校验失败是 `{error:'invalid_request', issues:[{path,message}]}`，**不是** `@hono/zod-validator` 的缺省形状；
新路由请用 `server/src/api/validation.ts` 的 `zodValidator`，别再直接用 `zValidator`。

## 三条不可绕过的架构线

1. **BASE_PATH 运行时可配**（[ADR-0003](docs/adr/0003-runtime-configurable-base-path-for-nginx.md)）：
   前端资产全部相对引用（`base: './'`），路径真相由服务端 `BASE_PATH` 注入页面
   （`window.__APP_CONFIG__.basePath`），Router `basename`、API 前缀、manifest `start_url`/`scope`
   都从它推导。**同一份构建产物**挂 `/` 或 `/dinner/` 都不用重打包。
2. **单进程前后端一体**（[ADR-0002](docs/adr/0002-ts-monorepo-react-hono-sqlite-single-process.md)）：
   生产一个 Node 进程同时服务 `/api/*` 与 `web/dist`，launchd 一个 plist 拉起   （部署见 spec §7；`/api` 未匹配时返回 JSON 404，绝不落到 SPA fallback）。

3. **共享类型由 server 导出**（ADR-0002、总纲 §6）：HTTP 的线上形状只在
   `server/src/wire-types.ts` 定义一处；web 侧一律
   `import type { MemberProfile } from '@dinnerorder/server/types'`，**不手抄**同形状接口。
   前端只用 `import type`（编译后 import 被抹掉，产物不会真去加载 server 的 Node 代码）。
   新增接口时先把形状加进 `wire-types.ts`，再让两端分别引用它。

## 写测试

集成测试一律用 harness，不要绕过它直接 `createApp()`——它保证每个测试拿到全新内存库：

```ts
import { createTestHarness } from './testing/harness.js';

const h = createTestHarness({ basePath: '/dinner' });
h.clock.set('2025-06-08T10:00:00.000Z');        // 可控时钟（去重窗口/冷藏期）
h.llm.setToolResult('some_tool', { content: '…' }); // 编程序 LLM 响应
const { status, body } = await h.json('/dinner/api/health'); // 进程内直打，不占端口
h.close();
```

`h.llm.calls` 记录每次调用（含失败调用），用来断言「LLM 被调用了几次、带了什么参数」。
