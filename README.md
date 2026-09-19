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
| `OPENAI_BASE_URL` | 无 | LLM 端点（OpenAI 兼容；百炼 DashScope 或本机代理）。缺它或 key 时推荐自动走**简化推荐**，其余功能不受影响 |
| `OPENAI_API_KEY` | 无 | LLM key。**绝不打印、绝不入库**；只写在仓库根 `.env`（chmod 600，已被 .gitignore 排除） |
| `LLM_MODEL` | `qwen3.8-flash` | 模型名（写进留痕的 `llm_model`，模板版本进 `llm_prompt_version`） |
| `DEBUG` | 无 | `DEBUG=1` 时把 LLM 的完整请求/响应落到 `data/logs/`（spec §4；随 `.env` 一起排除出备份），默认不落盘 |

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
  src/llm/              LLM seam：types（工具面 + completion）/ openai（真实端点，重试在编排层）/ fake（测试与 E2E）/ prompt（模板 + 机器可读段）/ recommendation-schema（Zod 校验）/ unconfigured（未配 key 时的占位）
  src/bootstrap.ts      createLlmClient() + bootstrap()：生产入口与 E2E 服务端共用的装配
  src/e2e-server.ts     E2E 专用入口：与生产同一条装配路，只把 LLM 换成确定性 fake
  src/testing/harness.ts 集成测试 harness（内存库 + 可控时钟 + fake LLM + 直打 HTTP）
  src/domain/            领域逻辑（食材字典、家人画像、菜谱、餐槽、份量、推荐管线）
  migrations/            编号 .sql（001 = 家人与食材字典，含种子；随库执行；004 = 外部菜谱池）
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
| `GET /api/recipes?status=` | 家庭菜谱库（缺省只给转正态，`all` 一次拿齐） |
| `GET /api/slots?days=` · `GET /api/slots/:id` | 餐槽与菜单；单餐响应内嵌 `portion`（本餐每道菜的生重） |
| `PUT /api/slots/:id` · `DELETE /api/slots/:id` | 定餐 = 改餐（整份菜单一次提交）· 取消（留痕只增不改） |
| `POST /api/slots/:id/undo-set` | **撤销换一整套**：把这一餐退回上一次「换一整套」之前那一套（恢复上一条事件的快照，撤销本身也是一条留痕）；没有可撤的就 409 `nothing_to_undo` |
| `GET /api/history/recent-dishes?days=` | 最近吃过的菜（去重窗口，走事件流） |
| `POST /api/slots/:id/recommendation` | **整餐推荐**（总纲 §4）：规则硬过滤与时令检索 → LLM 从池中选 → 降级链。不落库、不缓存，接受与否由下一次 `PUT` 决定 |
| `POST /api/slots/:id/candidates` | **换菜候选**（spec S2）：给一道菜要 3 个同位替换选项（各带理由、忌口排除原因、「没做过」标记）；`exclude` = 本换菜会话累积排除的菜（被换掉的 + 已出示过的候选），池干按 `none→dedupe→session` 放宽（忌口永不 relax）。不落库 |
| `GET /api/portion/rules` | 份量规则表：成人能量锚点 + WS/T 554 分带折算系数 + 各人群推荐量 + 餐次占比（逐条带来源） |
| `POST /api/portion/preview` | 草稿菜单的份量（编辑期即时重算；年龄按服务端时钟现算） |
| `GET /api/portion/exchange` | WS/T 554 附录 A 生熟/同类互换表（七组，带基准与口径） |
| `GET /api/portion/exchange/convert?from=&grams=` | 互换换算：`grams` 的 `from` 等价于组内各条的多少克 |

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
h.llm.setToolResult('some_tool', { content: '…' }); // 编程序 LLM 工具响应
h.llm.setCompletion('{"dishes":[…] }');        // 编程序 completion（推荐管线用）
h.llm.queueCompletion(new Error('超时'), '第二次成功'); // 排队逐次出参：降级链就是这么测的
const { status, body } = await h.json('/dinner/api/health'); // 进程内直打，不占端口
h.close();
```

`h.llm.calls` 记录每次工具调用（含失败调用），`h.llm.completionCalls` 记录每次 completion（含失败的那几次）——
用来断言「LLM 被调用了几次、带了什么参数」。推荐测试里还会直接断言 **prompt 内容**（池子、结构、
近 7 天已吃）：ADR-0001 决定「LLM 只从池中选」，所以池子就是契约的一部分。
