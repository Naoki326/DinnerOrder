# Findings：LLM 选型与 MCP 运行时集成

- 票：[#5](https://github.com/Naoki326/DinnerOrder/issues/5)（wayfinder:research）
- 调研日期：2026-09-19；分支：`research/llm-mcp-integration`
- 来源纪律：除特别标注「二手/未证实」外，所有价格、能力、协议结论均来自官方定价页 / 官方 API 文档 / MCP 官方 spec 与官方 SDK 仓库（抓取于调研当日）。

## TL;DR（结论先行）

1. **LLM：首选 qwen3.8-flash（阿里百炼），备选 GLM-5.3-Flash（智谱）；Kimi/DeepSeek 作为对照组；OpenAI 因大陆可达性问题直接排除。** 家用规模（每天 3–10 次推荐调用）下，轻量档模型月成本都在**个位数人民币**量级，成本不是决策变量，应按「结构化输出可靠性 + 中文菜品生成质量」选（质量需自评，见 open questions）。
2. **结构化输出：优先 `response_format=json_schema(strict)`。** qwen3.8-flash 官方明确支持 JSON Schema 严格模式；GLM 文档只承诺 `json_object`（字段结构靠 prompt + 客户端校验）；DeepSeek 只有 JSON Output 且官方承认偶发空内容。无论选谁，都要做 schema 校验 + 一次重试。
3. **MCP：客户端 SDK 已足够成熟**（TypeScript / Python 均为官方 Tier 1，v2.x、活跃维护），「后端作为 MCP host/client」是官方文档明确支持的模式（有专门的 build-a-client 教程与 client 最佳实践指南）。**但对我们只有 3 个自家工具的规模，MCP 的主要收益是进程隔离 + Inspector 调试 + 未来复用，代价是多进程内存与生命周期管理**——建议接口按 MCP 工具的形状设计（名称/描述/JSON Schema 参数），先用进程内直调跑通，再按需平移为 stdio MCP server。
4. **NAS 约束不大，硬指标是：Node ≥ 20（或 Python ≥ 3.10）+ 出站 HTTPS(443) + ≥ 2GB 内存较稳。** 全链路（LLM API + stdio MCP server）无入站端口需求，家人访问走既定的内网穿透即可。

**推荐组合**：Node.js ≥ 20（建议 24.x Active LTS）+ TypeScript 后端 → 官方 `openai` npm 包接百炼 `qwen3.8-flash`（base_url 指向百炼 OpenAI 兼容端点，`json_schema` 严格模式）→ 工具函数按 MCP 工具形状设计，M1 进程内直调，M2 视需要用 `@modelcontextprotocol/sdk` 平移为 stdio server 并用 MCP Inspector 调试。

---

## 一、家用场景 LLM 选型

### 1.1 候选与定价（全部一手：官方定价页，元/百万 tokens）

| 厂商/模型 | 输入（缓存未命中） | 输入（缓存命中） | 输出 | 上下文 | 结构化输出 | 工具调用 | 大陆直连端点 |
|---|---|---|---|---|---|---|---|
| 智谱 **GLM-5.3-Flash** | ¥0.8 | ¥0.23 | ¥2.8 | 1M | `json_object`¹ | ✅（`tool_choice` 仅支持 `auto`） | `https://open.bigmodel.cn/api/paas/v4/` |
| 智谱 GLM-5.3（旗舰） | ¥8 | ¥2 | ¥28 | 1M | 同上 | 同上 | 同上 |
| 阿里百炼 **qwen3.8-flash** | ¥0.8 | 上下文缓存享折扣² | ¥2.7 | 1M | `json_object` + **`json_schema` 严格模式** | ✅（并行调用、强制 `tool_choice`） | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| 阿里百炼 qwen3.8-max | ¥12 | 折扣² | ¥36 | 1M | 同上（json_schema 支持） | ✅ | 同上 |
| DeepSeek **deepseek-flash** | ¥1（空闲）/ ¥2（高峰） | ¥0.02 / ¥0.04 | ¥4 / ¥8 | 1M | `json_object`（官方注明偶发空内容） | ✅ | `https://api.deepseek.com`（另有 `/anthropic` 兼容端点） |
| 月之暗面 kimi-k2.6 | ¥6.5 | ¥1.1 | ¥27 | 256K | `json_object` + `json_schema`（复杂 schema 偶发不稳，官方注明） | ✅ | `https://api.moonshot.cn/v1` |
| 月之暗面 kimi-k3（旗舰） | ¥20 | ¥2 | ¥100 | 1M | `json_schema` 稳定 | ✅ | 同上 |
| OpenAI gpt-5.6-luna | $0.20 | $0.02 | $1.20 | 短上下文档 | `json_object` + `json_schema` 严格模式（文档明确「reliably matches schema」） | ✅ | `api.openai.com` —— **大陆不在官方支持名单（见 1.4）** |

¹ GLM 官方文档的模式是：`response_format={"type":"json_object"}` + system prompt 里给 JSON 结构示例 + **客户端 `jsonschema` 校验**；官方定价页另列有免费模型（GLM-4.7-Flash、GLM-4-Flash-250414 免费），适合开发期调试。
² qwen 的缓存是「折扣」计价而非单独档位；DeepSeek/Kimi/GLM 是显式缓存命中价。
免费额度：百炼每个模型新开 100 万 tokens（90 天有效）；GLM 有常驻免费小模型；DeepSeek/Kimi 定价页未列免费额度。

### 1.2 月成本量级估算（每天 3–10 次推荐调用）

假设（偏保守，含一轮工具调用往返与偶尔重试）：每次推荐调用输入 ≈ 5K tokens（system 提示 + 家人画像 + 菜谱检索片段 + 近期历史；按 GLM 官方换算 1 token ≈ 1.6 汉字、Kimi 官方 1 token ≈ 1.5–2 汉字，约 8–10K 字的上下文，足够），输出 ≈ 1.5K tokens。按 **10 次/天 × 30 天 = 300 次** 计（即 1.5M 输入 + 0.45M 输出/月）：

| 模型 | 月成本（全按缓存未命中、高峰价） |
|---|---|
| qwen-plus / qwen3.8-flash / GLM-5.3-Flash | **≈ ¥2–3** |
| deepseek-flash | ≈ ¥7 |
| GLM-5.3 | ≈ ¥25 |
| kimi-k2.6 | ≈ ¥22 |
| qwen3.8-max | ≈ ¥34 |
| kimi-k3 | ≈ ¥75 |
| gpt-5.6-luna | ≈ $0.84（≈ ¥6，未含中转加价与汇率波动） |

结论：**最贵旗舰也就每月几十元，轻量档每月个位数**；按每天 3 次算再打三折。菜单推荐这个量级下「定价」不构成决策约束，选型应看结构化输出可靠性与生成质量。（上限失控保护：所有平台都可在控制台设余额告警，充值制天然封顶。）

### 1.3 结构化输出 / 函数调用可靠性（各家官方文档原话级证据）

- **qwen（百炼）**：结构化输出分 JSON Object / JSON Schema 两档；JSON Schema 模式 `{"type":"json_schema","json_schema":{...,"strict":true}}` 「精确控制输出结构和类型，无需额外验证或重试」；官方支持模型表明确包含 **qwen3.8-flash / qwen3.7-flash / qwen3.7-plus / qwen3.7-max / qwen3.8-max 系列**。JSON Object 模式官方明示「不保证键名与字段类型稳定」。另有官方注意事项：标注「非思考模式」的模型在思考模式下 json_object 可能失效。
- **GLM（智谱）**：官方「结构化输出」文档只给 `json_object`，配套示例是**客户端 jsonschema 校验**（即官方推荐姿势就包含本地校验）；函数调用 `tool_choice` **默认且仅支持 `auto`**（不能强制指定函数）。
- **DeepSeek**：JSON Output 需 `response_format={'type':'json_object'}` + prompt 含 "json" 字样 + 合理 `max_tokens`；官方明确提示「**API 可能偶尔返回空内容**，我们正在积极优化」。工具调用文档完整（OpenAI 兼容 `tools` 参数）。
- **Kimi**：`response_format` 支持 `json_object` 与 `json_schema`；官方文档给了**模型间差异**：kimi-k3 稳定，k2.7-code 最稳（含 `oneOf`/`$ref`），**k2.6 复杂 schema 偶发不稳**（如 `$ref` 返回 Markdown 代码块、`oneOf` 被忽略），建议简单 schema + 业务层二次校验。另有动态加载工具、`tool_choice` 约束等工具调用最佳实践文档。
- **OpenAI**：Structured Outputs 文档明确区分两档——JSON mode「保证合法 JSON 但不保证 schema」、Structured Outputs「可靠匹配你指定的 schema」；JSON mode 官方也提示 edge cases 需自行检测处理。

**工程结论**：输出契约按「能拿到的最强模式」设计——主力走 `json_schema(strict)`（qwen3.8-flash / Kimi k3 / OpenAI 支持）；对只有 `json_object` 的模型（GLM/DeepSeek），退化为 prompt 内嵌 schema 示例 + Zod/Pydantic 校验失败重试一次。这个降级路径成本很低，不应为它牺牲模型选择。

### 1.4 中国大陆网络直连可达性

- **GLM / Qwen / DeepSeek / Kimi 四家的 API 域名均为大陆境内直连**（`open.bigmodel.cn`、`aliyuncs.com`、`api.deepseek.com`、`api.moonshot.cn`），官方文档即面向大陆开发者，出站 HTTPS 443 即可达——这是一手事实（端点即来自各自官方文档）。
- **OpenAI**：api.openai.com 大陆不可直连、且**中国大陆不在 OpenAI 官方支持的国家/地区名单**（官方名单页：`https://help.openai.com/en/articles/5347006-openai-api-supported-countries`；本会话抓取被 Cloudflare 拦截，未能存档原文，标注：一手链接、内容未在本会话复验）。「中转/聚合 API」生态（第三方售卖 OpenAI 端点）属**二手/未证实**：稳定性、密钥安全、计费透明都无保障。对家用自用 app，结论：**排除 OpenAI，除非家里本来就有合规出海网络环境**；即使有，中文家常菜场景也没有非它不可的理由。

### 1.5 中文家常菜谱/菜单生成质量口碑

**没有权威一手评测可引**（公开 benchmark 不覆盖「家常菜谱生成」这种垂直任务）。以下均为**二手/定位推断**：

- 四家大陆厂商（智谱/阿里/DeepSeek/月暗）的模型均为中文语料为主的一线国产模型，社区口碑普遍认为中文日常生活类生成质量可靠（二手，未证实）。
- 通用能力榜单（若引 LMSYS 等）与「菜谱是否像家常菜、份量建议是否合理、忌口约束是否听懂」相关性弱，**不建议据此定主力**。

**建议（进 open questions）**：用自家菜谱库出 20 个固定 case（含忌口/甜口/大小孩/季节约束），对 3–4 个候选模型做一次盲评再定主力——成本几乎为零（见 1.2 量级），这是唯一有效的一手质量证据。

---

## 二、MCP 运行时集成

### 2.1 MCP 是什么（官方 spec/文档摘要，spec 版本 2026-07-28）

- MCP 是开放协议：**MCP host（我们的后端 app）为每个 MCP server 建一个 MCP client 连接**；数据层为 JSON-RPC 2.0，核心原语是 tools / resources / prompts。
- 两种传输：**stdio（本机子进程，最常用）**与 **Streamable HTTP（远程）**。对我们的部署：菜谱库检索/份量计算/时令食材都可走 stdio 本地 server，零网络开销。
- 注意：**sampling（server 反向请求 host 的 LLM）在 2026-07-28 版 spec 已标记 deprecated**——设计工具时不要依赖「工具内部再借宿主的模型」这种模式；工具就该是确定性的取数/计算。
- 协议有版本协商与能力发现（`server/discover`），工具列表支持 `listChanged` 通知。

### 2.2 后端作为 MCP client 的成熟度（一手：官方 SDK 页 + 官方仓库）

官方 SDK 分级（Tier 1 = 完整协议实现、conformance 100%、关键 bug 7 天内修、稳定版本与文档）：

| SDK | Tier | 仓库活跃度（2026-09-19 查） | 运行时要求（官方仓库声明） |
|---|---|---|---|
| **TypeScript** | **Tier 1** | 13.4K stars，最近 push 2026-09-18 | **Node ≥ 20**（package.json engines） |
| **Python** | **Tier 1** | 24.3K stars，v2.2.0（2026-09-07 发布），push 2026-09-19 | **Python ≥ 3.10**（pyproject） |
| C# / Go / Rust | Tier 1 | 活跃 | — |
| Java | Tier 2 | 3.7K stars，v2.0.1 | — |
| Ruby | Tier 2 | — | — |
| Swift / PHP / Kotlin | Tier 3 | kotlin 0.15.0（未到 1.0） | — |

「应用作为 MCP client」是官方一等公民：官方有《Build an MCP client》多语言教程（含 Spring AI 的 `spring.ai.mcp.client.toolcallback.enabled=true` 自动把 MCP 工具注册为 LLM 工具的集成）、《Client Best Practices》（多 server/多工具规模化模式）、以及 MCP Inspector（命令行/网页调试任何 server）。**结论：TS/Python 后端做 MCP host，成熟度无风险。**

### 2.3 MCP server 适合承载什么（对比「直接在应用里写函数调用」）

| 维度 | 直接函数调用（进程内） | 做成 MCP server（stdio） |
|---|---|---|
| 实现成本 | 最低：函数 + JSON Schema 直接进 LLM `tools` | 多一层 JSON-RPC + 子进程管理（SDK 已封装大部分） |
| 内存 | 无额外进程 | 每个子进程一份运行时（实测参考：空转 Node 进程 ≈ 40MB、Python ≈ 15MB RSS，开发机测量、仅作量级参考） |
| 调试 | 靠自家日志 | **MCP Inspector 通用调试**、协议级可观测 |
| 复用/演进 | 绑死在本 app | 可被 Claude Desktop/编辑器等任何 MCP host 复用；可独立语言、独立发版 |
| 隔离 | 工具崩溃连带后端 | 子进程崩溃隔离、可重启 |

对三个候选工具逐个判断：

1. **菜谱库检索**：本质是「查询自建库」。MCP 化的收益是 Inspector 调试检索质量 + 未来可给家人桌面端 AI 直接用；进程内直调最省事。**两可，倾向先直调。**
2. **份量/营养计算**：纯确定性计算，无外部依赖、无独立演进需求。**直接函数调用收益最大，MCP 化纯属仪式感。**
3. **时令食材**：数据可能来自外部数据集/接口、需要周期性更新，独立成 server 可以单独更新不动主应用，且这是最可能有「别人也写过类似 MCP server」的领域。**最适合 MCP 化的一个。**

**给本项目的落地建议**（与地图 #1「MCP 定位：运行时工具集成」一致，不推翻）：工具接口先按 MCP 的形状设计（工具名 + description + JSON Schema 输入输出），实现放进程内直调（M1，最快跑通核心闭环）；把「时令食材 server 化」作为 M2 第一个 MCP 化对象验证整条链路，菜谱检索跟进与否看 M2 体验。这样既不被协议拖慢，又不锁死未来。

---

## 三、NAS/低配常开设备跑这条链的约束

1. **运行时版本是硬门槛**：MCP TypeScript SDK 要求 **Node ≥ 20**（官方 engines），Python SDK 要求 **Python ≥ 3.10**。NAS 自带 SSH 环境里的老 Node/Python 常常不满足——**用 Docker（群晖 Container Manager/威联通 Container Station）跑官方镜像最省心**。Node LTS 时间表（官方）：22.x 已进 Maintenance（EOL 2027-04-30），**24.x 为 Active LTS（EOL 2028-04-30），选它**。Node/Python 官方镜像均有 arm64 变体，x86/arm NAS 都能跑（常见常识，二手/未逐一验证各 NAS 型号）。
2. **内存量级**：链路 = 1 个后端进程（Node/TS 全家桶估 150–300MB）+ 若干 stdio MCP 子进程（每个 15–80MB 量级，见 2.3 实测参考）+ 数据库（SQLite 则忽略不计）。**2GB RAM 的 NAS 从容，1GB 紧张**（若还要跑穿透/下载等常驻服务）。这是工程估算而非某型号实测——具体 NAS 型号与内存属 open question。
3. **出站网络**：四家国产 LLM 端点全部是标准 **HTTPS 443 出站**，无特殊端口、无入站要求（家人访问走既定内网穿透方案，不在本票范围）。需要稳定的 DNS 与系统时钟（TLS 证书校验）。
4. **并发/限流**：家用量级远低于任何一家的最低限流档（例如 DeepSeek flash 并发限制 2500、百炼 flash 系列 RPM 数千档），无压力，不作约束。

---

## 四、推荐组合（汇总）

- **后端**：Node.js ≥ 20（建议 24.x Active LTS）+ TypeScript。
- **LLM 接入**：官方 `openai` npm 包（四家国产厂商都提供 OpenAI 兼容端点，一套 SDK 换 base_url/model 即可切换，也是换模型 A/B 的最低成本路径）。
- **主力模型**：**qwen3.8-flash**（大陆直连、¥0.8/¥2.7、strict json_schema、百炼 100 万 token 免费额度）；**备选 GLM-5.3-Flash**（¥0.8/¥2.8、缓存命中价更低、另有常驻免费小模型可做开发档；但结构化输出只有 json_object 档）。最终主力待 1.5 节的 20-case 自评后钉死。
- **结构化输出**：`response_format=json_schema(strict)` 为主，`json_object` + Zod 校验重试为降级路径。
- **工具集成**：接口按 MCP 工具形状设计；M1 进程内直调，M2 起「时令食材」先行 MCP 化（`@modelcontextprotocol/sdk`，Tier 1）+ Inspector 调试；不做依赖 sampling 的设计（已 deprecated）。

## 五、引用列表

**一手来源（本会话已抓取原文）**

- 智谱 GLM 定价：https://docs.bigmodel.cn/cn/guide/start/pricing
- 智谱 GLM 结构化输出：https://docs.bigmodel.cn/cn/guide/capabilities/struct-output
- 智谱 GLM 工具调用（tool_choice 仅 auto）：https://docs.bigmodel.cn/cn/guide/capabilities/function-calling
- 智谱 GLM OpenAI 兼容端点：https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
- 阿里百炼模型计费（qwen3.8-max/plus/flash 等）：https://help.aliyun.com/zh/model-studio/model-pricing
- 阿里百炼结构化输出（JSON Object/JSON Schema 模式与支持模型表）：https://help.aliyun.com/zh/model-studio/qwen-structured-output
- 阿里百炼 Function Calling：https://help.aliyun.com/zh/model-studio/qwen-function-calling
- DeepSeek 模型与价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- DeepSeek JSON Output（含偶发空内容提示）：https://api-docs.deepseek.com/guides/json_mode
- DeepSeek Tool Calls：https://api-docs.deepseek.com/guides/tool_calls
- Kimi 模型推理价格：https://platform.moonshot.cn/docs/pricing/chat
- Kimi 模型列表：https://platform.moonshot.cn/docs/models
- Kimi response_format / Structured Output（含模型间差异）：https://platform.moonshot.cn/docs/guide/response_format
- OpenAI Pricing（gpt-5.6-luna 等）：https://platform.openai.com/docs/pricing
- OpenAI Structured Outputs / JSON mode：https://platform.openai.com/docs/guides/structured-outputs
- MCP 官方 SDK 列表与分级：https://modelcontextprotocol.io/docs/2026-07-28/sdk
- MCP SDK 分级标准（Tier 1/2/3 要求）：https://modelcontextprotocol.io/community/sdk-tiers
- MCP 架构总览（host/client/server、stdio/HTTP、sampling 弃用）：https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture
- MCP Specification（2026-07-28 版）：https://modelcontextprotocol.io/specification/2026-07-28
- MCP Tools spec：https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP Build a client 教程：https://modelcontextprotocol.io/docs/2026-07-28/develop/build-client
- MCP Client Best Practices：https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices
- MCP python-sdk（Python ≥3.10、v2.2.0）：https://github.com/modelcontextprotocol/python-sdk
- MCP typescript-sdk（Node ≥20）：https://github.com/modelcontextprotocol/typescript-sdk
- Node.js 发布时间表（22.x Maintenance / 24.x Active LTS）：https://github.com/nodejs/Release#release-schedule

**一手链接、本会话未能存档（Cloudflare 拦截）**

- OpenAI 支持的国家/地区名单（大陆不在列）：https://help.openai.com/en/articles/5347006-openai-api-supported-countries

**二手/未证实（正文已就地标注）**

- 「国产一线模型中文日常生成口碑好」的社区共识；OpenAI 中转/聚合 API 生态的可用性；Node/Python 官方镜像 arm64 覆盖各 NAS 型号的细节。
- 进程内存实测（Node 空转 ≈ 40MB / Python ≈ 15MB RSS）：本会话开发机实测，量级参考，非 NAS 实测。

## 六、Open questions

1. **主力模型待自评**：用自家菜谱库出 20 个固定 case（忌口/甜口/大小孩/季节），盲评 qwen3.8-flash vs GLM-5.3-Flash vs deepseek-flash（± kimi-k2.6）的菜单质量——这是唯一有效的一手质量证据，做完即钉死主力。归后续原型/开发票。
2. **GLM 是否上线 strict json_schema**：当前文档只有 json_object；若自评胜出的是 GLM，需按降级路径（json_object + 校验重试）实现，或关注其文档更新。
3. **实际 NAS 型号/内存/是否可跑 Docker 未确认**（影响打包形态与 M2 是否值得拆 stdio server）；地图 #1 的「NAS/常开电脑」二选一在部署票里定。
4. **时令食材的数据源**：用开源数据集、还是买/抓一份月历数据进自家库？数据形态影响该工具（及是否 MCP 化）的接口设计。归数据票。
5. **OpenAI 兜底**：仅当家中有合规出海网络与支付渠道时才值得保留为对照组；默认排除。
