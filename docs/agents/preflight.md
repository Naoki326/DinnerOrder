# 实施 preflight（环境事实与硬性约束）

本文件是本次 M1 全量实施的**环境事实**来源。派发给实施子代理前由调度层确认；子代理按此作为环境真相，不要再自行探测同一件事（重复探测很贵）。

## 1. 环境（已由调度层核实）

| 项 | 事实 |
| --- | --- |
| 仓库根 | `/Users/chenjingjing/DinnerOrder`（唯一正确工作目录） |
| 远端 / tracker | **GitHub** `Naoki326/DinnerOrder`；issue 操作一律用 **`gh`**（已认证）。**没有 glab，不是 GitLab** |
| 默认分支 | **`main`**（不是 `master`）。不建分支、不 force push、不 rebase 改历史 |
| Node | **v22.22.2**（`/opt/homebrew/bin/node`，Homebrew `node@22`）。**没有 Node 24**——不要用 Node 24 特性（如 `node:sqlite`、需要 24 的 API） |
| pnpm | **12.4.2**，经 `corepack enable pnpm` 激活（`pnpm -v` 可直接用） |
| npm registry | 可达（约 1.7s 往返，境外源，装包偏慢要有耐心） |
| sqlite3 CLI | 3.51.0 可用（部署票的 `.backup` 热备用它） |
| Playwright 浏览器 | **固定 `@playwright/test@1.58.0`**。本机浏览器缓存里现在有 **chromium-1208**，正是 1.58.0 需要的版本，装它**免下载**。（先前 preflight 误写「chromium-1217 ↔ 1.58.0」，实际 1217 对应 1.59.x；#13 实施时已按 1.58.0 下载 1208 并替换缓存。**别再改版本**，改版本会触发重新下载。） |

## 2. LLM 端点（本机代理，OpenAI 兼容）

本机 `127.0.0.1:8004` 跑着 OpenAI 兼容代理（DashScope 百炼在这个环境**没有 key**；不要在实施期依赖它）。

- `.env`（已在仓库根，chmod 600，**已被 .gitignore 排除，绝不入库、绝不在报告里打印 key**）：
  - `OPENAI_BASE_URL=http://127.0.0.1:8004/codebuddy/v1`
  - `OPENAI_API_KEY=<已注入，勿打印>`
  - `LLM_MODEL=deepseek-v4.1-flash`
- 调度层实测：`POST {OPENAI_BASE_URL}/chat/completions`，`Authorization: Bearer <key>`，`model=deepseek-v4.1-flash` 可用。
- **关键能力事实（已实测，别再花时间验证）**：
  - 纯 completion：正常。
  - `response_format={"type":"json_object"}`：**稳定可用**，返回干净 JSON（无 markdown 包裹）。
  - `response_format={"type":"json_schema", strict:true}`：**不被支持**——返回自由文本，可能被 markdown 代码块包裹。因此**严格 schema 那一档要走「`json_object` + Zod 校验 + 失败重试」**，并把这个真实能力差异记进代码注释或 ADR，而不是假装 strict 生效。
- 真实调用成本低（单次约 1–2 秒），但不做无节制的循环真调用。

## 3. 硬性纪律（每条都很贵，违反的代价由后续所有票承担）

1. **不做范围外的事**：只实现本工单 acceptance criteria 要求的。完工停手，不顺手重构别的模块、不加「未来会用到」的抽象。
2. **不搭重型验证基建**：不要为「跑一遍看看」引入 headless DOM / jsdom / 新的测试框架或工具链。用现成测试、静态断言、API 层集成测试判定；代价大的验证写进报告作为「建议人工走查项」。
3. **不打印密钥**：报告、commit、测试输出里不得出现 `.env` 内容或任何 key（连前缀都不行）。
4. **时间边界**：同一方向试 2–3 次没进展就停下换路。阻塞规则（同一错误连续 3 次失败 / 需产品决策而 issue 与代码库都答不了 / 撞上明显超出本工单范围的存量问题）→ 停止，`git stash`（message 带 issue 编号），报告以 `BLOCKED` 开头。
5. **不 commit**：把全部改动留在工作区（staged 或 unstaged 均可），由调度层审查后统一提交。
6. 环境的坑先读本文件，**不要再重复探测** Node/pnpm/网络/LLM 端点能力。
