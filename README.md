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
| `pnpm deploy:install` | **部署到常驻主机**：launchd 自启与崩溃拉起 + nginx 子路径反代 + `.env` 权限 + 备份排除。先 `--dry-run` 看一眼。见 [`docs/deploy/README.md`](docs/deploy/README.md) |
| `pnpm deploy:status` | 部署巡检（服务装载状态、热备清单、密钥权限、排除项） |
| `pnpm deploy:uninstall` | 卸载（**不删数据**：库、热备、`.env` 都留着） |
| `pnpm backup` | 手动跑一次 SQLite 热备（`backups/dinner-<日期>.db`，按日滚动保留 7 份） |

## 冷启动导入（外部菜谱池打底，总纲 §2.8、§5；ADR-0006）

外部菜谱池（150–300 道家常草稿）是**离线批处理**，不进产品界面，也没有 HTTP 入口。分三步，
每一步都能单独重跑（**导入本身完全离线**：网络只在下面第 1、3 步的有界取数命令里）：

```bash
# 1. 取数：HowToCook（Anduin2017/HowToCook，Unlicense 公有领域，约 1.5 MB markdown）
git clone --depth 1 --filter=blob:none --sparse https://github.com/Anduin2017/HowToCook.git /tmp/htc
cd /tmp/htc && git sparse-checkout set --no-cone '**/*.md' && cd -

# 2. 采集 + 筛选成快照（不碰网，按 id 去重）。--snapshot 落进仓库，导入从此可复现
pnpm --filter @dinnerorder/server run import:library \
  --collect-htc /tmp/htc/dishes --snapshot server/library-data/howtocook.jsonl

# 3. 抓下厨房热榜（可选，无开放许可、自家私用风险自知——ADR-0006；只有这一步碰站点）
pnpm --filter @dinnerorder/server run fetch:xiachufang --out data/xiachufang --top 12

# 4. 导入为草稿 + 出报告（加 --llm 走 LLM 份量重标与菜系初打；加 --dry-run 只算不写）
pnpm --filter @dinnerorder/server run import:library \
  --from server/library-data/howtocook.jsonl --xcf-dir data/xiachufang --llm

# 补了字典别名 / 改了筛选口径后重跑：缺省幂等（同 id 已有草稿就跳过），
# --replace 把**草稿**清掉重写（家庭菜谱永不覆盖）
pnpm --filter @dinnerorder/server run import:library \
  --from server/library-data/howtocook.jsonl --replace
```

注意：参数**直接跟在脚本名后**，不要再插一个 `--`——本仓库的 pnpm（12.4.2）会把 `--`
原样转发给脚本，而 CLI 是 `allowPositionals:false`，于是直接报 `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`。
脚本内的相对路径一律按**仓库根**解析，所以上面的命令请在仓库根执行（`--db` / `--report`
缺省落在 `data/`，已 gitignore）。

产出：`data/import-report.json`（导入量 / 重标覆盖率 / **归一失败清单**——这三项就是验收口径）。
下厨房那条路失败（429、超时、页面改版）**只降级不阻塞**：报告里如实标「抓取不可达」，
HowToCook 那条路照常跑完；**不要**为它引入 headless 浏览器或反复重试。

两条纪律：

* **来源字段如实**：HowToCook → `howtocook`、下厨房 → `scraped`、LLM 生成 → `llm`（`recipes.source`，002 的 CHECK）。
* **「适量」一律不猜克数**：采集时没有明确重量单位的项落 0 克并进重标待办（`relabel.pending`），
  由 LLM 在离线路径重标；覆盖率和待办清单是可重复跑出来的，不是报告里的口头数字。
  **含 0 克项的草稿不进推荐与换菜候选池**（它乘出来就是 0 g）：这是 0 克「待重标」这个显式状态的
  正确后果，重标写回正数后自动回来。

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
  src/llm/              LLM seam：types（工具面 + completion）/ openai（真实端点，重试在编排层）/ fake（测试与 E2E）/ prompt（模板 + 机器可读段）/ recommendation-schema（Zod 校验）/ import-schema（导入期重标与菜系初打，json_object + Zod）/ promotion-schema（转正改写：口述差异 + 待重标项，json_object + Zod）/ unconfigured（未配 key 时的占位）
  src/library/          冷启动采集器（HowToCook markdown / 下厨房 HTML / LLM 生成草稿；纯解析、吃 fixture、不碰网）
  scripts/              import-library（采集成快照 + 归一 + 落库 + 报告）· fetch-xiachufang（有界抓热榜）
  library-data/         HowToCook 采集快照 JSONL（导入的输入，随仓库走）
  src/bootstrap.ts      createLlmClient() + bootstrap()：生产入口与 E2E 服务端共用的装配
  src/e2e-server.ts     E2E 专用入口：与生产同一条装配路，只把 LLM 换成确定性 fake；另挂一个测试专用的时钟控制口（需 `E2E_CLOCK_CONTROL=1`，生产入口没有；S6 转正要把一餐拨到「已经吃过」）
  src/testing/harness.ts 集成测试 harness（内存库 + 可控时钟 + fake LLM + 直打 HTTP）
  src/domain/            领域逻辑（食材字典、家人画像、菜谱、餐槽、份量、推荐管线、导入管线）
  src/deploy/            部署与运维：launchd plist 生成 · 每日热备（sqlite3 .backup + 按日滚动）· nginx 片段与 include 插入 · 8080 导航页生成 · .env 权限与备份排除 · 装机/卸载编排
  migrations/            编号 .sql（001 = 家人与食材字典，含种子；随库执行；004 = 外部菜谱池；005 = 导入工具链；006 = 反馈与家规；007 = 留量与留量上浮列；008 = 转正台账；009 = 买菜清单；010–012 = 家人软删、按餐指定掌勺者、营养与食谱）
web/                    @dinnerorder/web —— React 18 + Vite + Router 7 + TanStack Query
  src/identity.tsx      当前身份（设备本地：localStorage；家人画像在服务端）
  public/favicon.ico    页签图标（**必须在 public 根**：浏览器未声明时会要 origin 根的这一个路径）
  public/icons/icon.svg 图标真源（改设计只改它，各档 PNG/ICO 由脚本生成）
  scripts/icons/        图标生成脚本与说明（`pnpm --filter @dinnerorder/web run icons`）
e2e/                    Playwright 冒烟 + 家人与当前身份
deploy/                 部署产物：nginx/dinner-location.conf（宿主 include 的片段，随仓库走）· tm-exclusions.txt（备份排除清单，**装机生成、不入库**：含本机绝对路径）
docs/deploy/README.md   部署与运维手册（安装/卸载/备份恢复/导航页与图标/排障/实测记录）
```

## API（M1 增量，无登录 · 家庭 Wi-Fi 即门禁）

| 路由 | 作用 |
| --- | --- |
| `GET /api/health` | 冒烟：时钟/LLM/basePath 的注入证明 |
| `GET /api/ingredients?q=` | 食材字典（规范名 + 别名；`q` 两者都匹配） |
| `GET /api/members` · `GET /api/members/:id` | 家人画像（大人/小孩、性别、出生年月、忌口、爱吃）。**已删的家人不出现**（软删除，`GET /members/:id` 也一样 404） |
| `POST /api/members` | 新增家人：`name` / `emoji` / `kind` / `gender` 必填，小孩另需 `birthMonth`（201 + 落库后的画像） |
| `PATCH /api/members/:id` | 改画像：`birthMonth` / `avoid[]` / `loves[]`，传了的块整体替换 |
| `DELETE /api/members/:id` | **软删除**家人（打 `deleted_at`，不删行）：从列表与用餐者名单里消失、忌口/爱吃不再生效，但餐历史快照与 `dish_feedback` 一行不丢 |
| `GET /api/recipes?status=` | 家庭菜谱库（缺省只给转正态，`all` 一次拿齐） |
| `GET /api/recipes/:id` | 单道菜谱（含食材克数、口味、菜系、状态） |
| `POST /api/recipes/:id/promotion` | **转正**（总纲 §2.8、spec S6）：草稿 → LLM 改写成家里版本（可口述差异、校对菜系）→ 状态 `active` 进家庭库与推荐池。门槛：只转**已经上桌**的草稿（ADR-0006）；LLM 失败就整次失败（502），草稿原样留着 |
| `GET /api/recipes/:id/promotions` | 某道菜的转正台账（编辑留痕：谁按谁的口述改的、菜系前后值、LLM 元数据） |
| `GET /api/slots?days=` · `GET /api/slots/:id` | 餐槽与菜单；单餐响应内嵌 `portion`（本餐每道菜的生重） |
| `PUT /api/slots/:id` · `DELETE /api/slots/:id` | 定餐 = 改餐（整份菜单一次提交；`leftoverOf` = 预定成吃某餐剩的，菜品必须为空）· 取消（留痕只增不改；`released[]` 报出被联动画回未定的引用方） |
| `POST /api/slots/:id/undo-set` | **撤销换一整套**：把这一餐退回上一次「换一整套」之前那一套（恢复上一条事件的快照，撤销本身也是一条留痕）；没有可撤的就 409 `nothing_to_undo` |
| `GET /api/history/recent-dishes?days=` | 最近吃过的菜（去重窗口，走事件流） |
| `POST /api/slots/:id/recommendation` | **整餐推荐**（总纲 §4）：规则硬过滤与时令检索 → LLM 从池中选 → 降级链。不落库、不缓存，接受与否由下一次 `PUT` 决定 |
| `POST /api/slots/:id/candidates` | **换菜候选**（spec S2）：给一道菜要 3 个同位替换选项（各带理由、忌口排除原因、「没做过」标记）；`exclude` = 本换菜会话累积排除的菜（被换掉的 + 已出示过的候选），池干按 `none→dedupe→session` 放宽（忌口与**冷藏期**永不 relax）。不落库 |
| `POST /api/feedback` | **写一条反馈**（总纲 §2.5）：菜品 × 家人 + 点踩/赞 + 快捷标签（太油/太甜/量太多/量太少）。同一人同一餐同一道菜重复提交 = 改主意（UPDATE，不堆历史）；点踩由任一本餐用餐者触发即进**冷藏期**（家规，默认 14 天） |
| `GET /api/feedback?days=` | 窗口内的反馈 + **正在冷藏期的菜**（带到期日，界面据此解释「这道为什么没出现」）+ **饭后餐卡**（窗口内已上桌的餐） |
| `DELETE /api/feedback` | 撤回一条反馈（判定只有赞/踩两种，「什么都不说」用撤回表达） |
| `GET /api/family-rules` · `PATCH /api/family-rules` | 家规（单例配置，总纲 §3「全部可调」）：读给界面（冷藏期天数 + 餐次截止时刻 + 留量上浮系数），写开放**会进聚合的那三个**（留量上浮系数默认 1.5× + 午/晚截止时刻）；改了它们会把进行中的买菜清单标过期（`family_rules_changed`） |
| `GET /api/portion/rules` | 份量规则表：成人能量锚点 + WS/T 554 分带折算系数 + 各人群推荐量 + 餐次占比（逐条带来源） |
| `POST /api/portion/preview` | 草稿菜单的份量（编辑期即时重算；年龄按服务端时钟现算）。可带 `slotId`（必须是真餐槽 id，否则 400 `invalid_slot_id`）：留量上浮要问「这一餐有没有被『吃剩的』引用」 |
| `GET /api/portion/exchange` | WS/T 554 附录 A 生熟/同类互换表（七组，带基准与口径） |
| `GET /api/portion/exchange/convert?from=&grams=` | 互换换算：`grams` 的 `from` 等价于组内各条的多少克 |
| `GET /api/grocery` | **买菜清单**（总纲 §2.7、S8）：进行中的清单（聚合行 + 手工行 + 逐行勾选 + 过期标记**结构**：原因枚举 `staleReason` + 哪一餐 `staleSlotId`，那句中文由界面现拼）或 `null`（没定过餐/刚归档且菜单没变）、家庭时区的今天、已归档份数 |
| `POST /api/grocery/recalculate` | **手动重算**：重新聚合 + 勾选按食材继承 + 手工行保留 + 清过期标记（只认进行中的清单，否则 409 `no_grocery_list`） |
| `POST /api/grocery/archive` | **买完归档**：进行中 → 已归档（勾选一起封存）；没有进行中的清单 → 409 |
| `POST /api/grocery/items` · `PATCH /api/grocery/items/:id` · `DELETE /api/grocery/items/:id` | 手工行增删 + 逐行勾选（`PATCH` 送显式布尔，不是 toggle）；聚合行不可手工删（400 `aggregate_item_not_deletable`） |

**错误响应形状统一为 `{error: '<代码>'}`**（可能附指认字段，如 `unknown_ingredient` 带 `ingredientId`）。
入参校验失败是 `{error:'invalid_request', issues:[{path,message}]}`，**不是** `@hono/zod-validator` 的缺省形状；
新路由请用 `server/src/api/validation.ts` 的 `zodValidator`，别再直接用 `zValidator`。

## 三条不可绕过的架构线

1. **BASE_PATH 运行时可配**（[ADR-0003](docs/adr/0003-runtime-configurable-base-path-for-nginx.md)）：
   前端资产全部相对引用（`base: './'`），路径真相由服务端 `BASE_PATH` 注入页面
   （`window.__APP_CONFIG__.basePath`），Router `basename`、API 前缀、manifest `start_url`/`scope`
   都从它推导。**同一份构建产物**挂 `/` 或 `/dinner/` 都不用重打包。
2. **单进程前后端一体**（[ADR-0002](docs/adr/0002-ts-monorepo-react-hono-sqlite-single-process.md)）：
   生产一个 Node 进程同时服务 `/api/*` 与 `web/dist`，launchd 拉起   （部署见 spec §7；`/api` 未匹配时返回 JSON 404，绝不落到 SPA fallback）。
   **注意**：部署时装的是**两个实例**（`8787` + `BASE_PATH=/` 供直连；`8786` + `BASE_PATH=/apps/dinner`
   供 nginx 子路径），它们共用同一个 SQLite 文件——一个进程只能有一个 `BASE_PATH`，而 S10 要求两条通道都可用。
   理由与取舍见 [`docs/deploy/README.md`](docs/deploy/README.md)。

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
