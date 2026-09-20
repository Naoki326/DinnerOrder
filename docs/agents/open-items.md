# 跨票欠账台账

本文件记录**审查发现但有意不在当票处理**的项，避免它们在后续票里被再次"发现"或彻底丢失。每条注明来源票、归属票与理由。

> 维护约定：当票审查发现的项，若判断应由别的票承接，就登记在此，并在派发该票时点名。条目被处理后在原行标注 `✅ 已由 #<票> 处理`。

---

## 📍 交接状态（2026-09-19 会话交接，新对话从这里开始）

### 队列进度

| 票 | Issue | Commit | 测试 | 状态 |
|---|---|---|---|---|
| 1 | #13 M1-01 骨架与测试 seam | `f16c354` | 53 unit + 2 E2E | ✅ CLOSED |
| 2 | #14 M1-02 家人与当前身份 | `3dce3a6` | 72 unit + 5 E2E | ✅ CLOSED |
| 3 | #15 M1-03 菜谱库、手动定餐与留痕 | `8a71bf7` + `e199b4d` | 121 unit + 9 E2E | ✅ CLOSED |
| 4 | #16 M1-04 份量引擎 | `482884d` | 155 unit + 13 E2E | ✅ CLOSED |
| 5 | #17 M1-05 整餐推荐管线 | `d7b74d6` | 225 unit + 18 E2E | ✅ CLOSED |
| — | （台账文档） | `b9c0343` | — | — |
| 6 | **#18 M1-06 换菜与候选** | —（未 commit，改动在工作区） | 266 unit + 27 E2E | ✅ 实现完成（含审查修复），待审查 |
| 7 | **#19 M1-07 冷启动导入工具** | —（未 commit，改动在工作区） | 324 unit + 27 E2E | ✅ 实现完成（含审查修复），待审查 |
| 8 | #20 M1-08 反馈、餐后回顾与冷藏期 | — | 341 unit + 29 E2E | ✅ 实现完成，待审查 |
| 9 | **#21 M1-09 转正流程** | `e4df3be` | 383 unit + 33 E2E | ✅ CLOSED |
| 10 | #22 M1-10 留量 | `1a88e78` | 375 unit + 36 E2E | ✅ CLOSED |
| 11 | **#23 M1-11 买菜清单** | 见下 | 396 unit + 40 E2E | ✅ 实现完成，待审查 |
| 12 | **#24 M1-12 三视图与视图模式** | 见下 | 322 unit + 31 E2E | ✅ 实现完成，待审查 |
| 13 | #25 M1-13 部署与备份 | 见下 | 582 unit（含 71 新增）+ 73 E2E | ✅ 实现完成 + **已真装到本机** + 审查修复轮，待提交 |
| 14 | #26 M1-14 验收收尾 | — | — | 待做 |
| — | **#12 父 spec 收尾** | — | — | 全部子票关闭后处理 |

**部署现状（#25 已真装到 `chenMac-mini.local`）**：两个 launchd 服务实例（`8787` `BASE_PATH=/` 供直连、
`8786` `BASE_PATH=/apps/dinner` 供 nginx，共用一个库）+ 每日 03:00 热备 agent；宿主 nginx
（`servers/apps-proxy.conf`）只多了一行 include，片段在 `deploy/nginx/dinner-location.conf`。
巡检用 `pnpm deploy:status`，装卸用 `pnpm deploy:install` / `pnpm deploy:uninstall`（**不删数据**）。
**⚠️ 手工启动的那个 `/tmp/demo.db` 实例已被 #25 取代**（它占着 8787 且库在 /tmp，不受任何备份通道保护）；
生产库现在是 `data/dinner.db`。那份演示库仍留在 `/tmp/demo.db`（未删，但那 6 位家人**不在**生产库里）。
详见 [`docs/deploy/README.md`](../../docs/deploy/README.md)。

**建议执行顺序**（依赖关系）：#20 → #21；#19 可与 #20 并行；#22（依赖 M1-04 已完成）→ #23；#24（依赖 #18 已实现，待审查）→ #23；#25 已完成；#26 最后。

### 新对话开工前必读

1. `docs/agents/preflight.md` —— **环境事实**（LLM 端点、Node 22、时间边界硬规则、禁写调试脚本）
2. `README.md` —— 三条不可绕过的架构线、命令契约、写测试约定
3. `CONTEXT.md` —— 领域词汇表（命名必须照它）
4. `docs/spec/implementation-spec.md` —— 权威总纲
5. 本文件的「跨票欠账」各节 —— 看当前票有没有待承接项

### 环境事实速查

- **LLM 端点**：本机 `127.0.0.1:8004`（OpenAI 兼容），配置在仓库根 `.env`（**已 gitignore，绝不入库**）。模型 `deepseek-v4.1-flash`。
- **实测能力**：纯 completion ✅ ／ `json_object` ✅ 稳定 ／ **`strict json_schema` 不被支持**（实现按「失败即转 `json_object`」处理，有测试覆盖）。
- **测试现状**：`pnpm test` 341 条（23 文件 + 1 跳过，含 2 条真 LLM 冒烟）／`pnpm test:e2e` 29 条（**3 个 webServer 实例**：8790 根路径、8791 子路径、8792 LLM 故障）。
- **外部菜谱池**：`server/library-data/howtocook.jsonl`（HowToCook 采集快照，**266 道**——采集侧已按 id 去重，去重前的 372 篇里有 1 条同 id；重跑命令见 README）+ 导入 CLI（`pnpm --filter @dinnerorder/server run import:library`，参数直接跟在脚本名后、不要插 `--`）。导入完全离线；LLM 重标/菜系初打只在加 `--llm` 时发生（走 `json_object` + Zod）。详见 `server/library-data/README.md`。
- **E2E 必须 `pnpm test:e2e`**（它先 build）；直接 `npx playwright test` 会跑**旧构建产物**——这个坑已踩过一次。

### 本次会话踩过的坑（写进 dispatch 与全局规则，避免重犯）

1. **子代理收不到全局规则**：`~/.pi/agent/APPEND_SYSTEM.md` 只对主会话生效，子代理的 system prompt 里没有它，也收不到项目 `AGENTS.md`。**凡子代理必须遵守的硬规则，一律写进 dispatch 正文。** 某票因我在 dispatch 里弱化措辞（把 `playwright` 从禁令删掉），子代理写了 `node debug-slot.mjs` 调试脚本、**没设 timeout 挂了 11 分钟**拖死工单。
2. **不要 amend 已推送的 commit**：曾误 amend 已 push 的 `8a71bf7`，后用 `git reset --soft origin/main` + 新 commit 纠正。**amend 前先跑**：`git branch -r --contains HEAD | grep -q . && echo 已在远端`。
3. **验证要看真实产物**：改源码后忘了 `pnpm build`，导致 E2E 一直在测旧 `web/dist`，白追几轮。
4. **审查子代理用 `general-purpose`**（有 bash）；`explore` 类型只有 read/grep/find/ls，**跑不了 git diff 与测试**，证据等级弱。
5. **测试写死计数必坏**：留痕是 append-only，历史永不删除 → 断言只能用「相对本次操作」的写法。
6. **E2E spec 的文件名顺序是隐含依赖**：`meal.spec.ts` 断言「未定餐槽的留痕是空的」，任何在它**之前**跑、
   往餐槽写留痕的 spec 都会把它打红（append-only，清不掉）。新增 spec 起名要注意字母序——
   #20 的 `review.spec.ts` 取名就是这个原因（叫 `feedback.spec.ts` 会因为 `f < m` 而先跑、打红 meal）。

---

## 跨票欠账（按归属票分组）

## 归属 #17（整餐推荐管线）

- ✅ 已由 #17 处理（实现完成，待审查）；下面两条是实施中发现、**有意不在本票处理**的项。

- **家规公式仍是常量，未落家规表**（来源：#17 实施）。`server/src/domain/recommendation.ts` 的
  `BASELINE`（2 荤 1 素 1 汤）、`BASELINE_ADULTS`、`DEDUPE_DAYS`（7）、`LLM_TIMEOUT_MS`（30s）、
  `MIN_FAMILY_PER_POSITION`（3）、`MAX_FAMILY_PER_POSITION`（8）都是实施者自定的常量；
  spec §2.2/§4 说这些值属家规（“家规可调”）。
  **#20 只搬了餐次截止（`MEAL_CUTOFF_HOUR` → `family_rules` 表）；其余常量由 #26 统一收口**——
  #20 的家规表（`family_rules`，单例）就是收口的落点，届时追加列即可（本票已在这几处标了 TODO）。

- **近 30 天反馈摘要进 prompt 的位置已留好但没人填**（来源：#17 实施）。
  `buildPrompt({ feedbackSummary })` 已就位并有测试；但 #17 的 AC 不含反馈采集，
  调用方（`recommendMeal`）不传它。
  ✅ **已由 #20 处理**：`recommendMeal` 与 `findCandidates` 都传 `feedbackSummary(db, clock)`
  （两条 prompt 模板各 +1 版本号；换菜那条也用同一段标记【近 30 天反馈】）。

- **换菜（单道 3 候选 / 换一整套 / 反悔）未实现**（来源：#17 范围界定）。
  #17 的 AC 只要求整餐推荐 + 一键接受，`MealEventType.replace_set` 已在 002 备好但没人写。
  **#18 需接**：单道下钻 3 候选（各带理由、同会话累积排除）、换一整套、回上一条快照。
  可直接复用：`buildPool`（池子）、`rankPool`（规则降级排序）、`selectWithLlm`（降级链）。

- **本机代理端点不支持 strict `json_schema`，E2E 因此看不到 `json_schema` 档的降级**
  （来源：#17 实施，preflight 已记录）。真实部署（DashScope）能走 strict 档；本机只能走
  `json_object` 档。代码两档都在、`RecommendationFormat` 会把实际档位报出来，
  集成测试用 fake 两档都覆盖了。**部署到 Mac mini 后建议人工走查一次真调用的 format。**

## 归属 #18（换菜与候选）

- ✅ 下面两条已由 #18 处理（实施完成，两笔欠账均已收口）。

- ✅ **`replace_set` 事件类型的语义归属**（来源：#17 审查）。**决定：复用 `replace_set` + 用 `source` 区分，不新造事件类型**（#15 预留的枚举优先复用，免重建 append-only 表）。
  - `replace_set` + `recommendation` = 换一整套（含「已定餐槽接受整餐推荐」）；
  - `replace_set` + `manual` = 撤销本身（撤销也是一条新事件，恢复上一条事件的快照）。
  - **撤销可用性** = 末事件是 `replace_set` + `recommendation`（`MealSlot.canUndoSet`）；撤销后末事件变 `manual` → 不再可撤销（无 ping-pong）。
  - 实现与理由写进：`server/src/domain/slots.ts`（`canUndoSet`/`undoSet` 的注释）、`server/src/wire-types.ts`（`MealEventType` 注释）、`server/src/api/slots.test.ts` 的「换一整套的撤销」describe。
- ✅ **`promptVersion` 可被伪造**（来源：#17 审查）。**已收紧**：`PROMPT_VERSIONS_BY_SOURCE`（`server/src/llm/prompt.ts`，判断入口是 `promptVersionFor`）把「来源 → 允许的模板版本」绑起来——`source='recommendation'` 只接受整餐推荐模板 `PROMPT_VERSION`（换菜候选模板不产生这种留痕）；`bookSlot` 不匹配就 `UnknownPromptVersionError` → 400 `unknown_prompt_version`。测试在 `server/src/api/slots.test.ts`（「LLM 元数据的 prompt 版本校验」，含「候选模板版本 → 400」一条）。
  - **后续加新的「带 LLM 元数据的落库路」时往 `PROMPT_VERSIONS_BY_SOURCE` 加一条**（判断只在这一处），否则那条路的留痕会被 400 拦下（这是故意的：宁可拒收，也不让留痕里出现解释不了的版本号）；只改措辞（新增版本号）则改对应常量值，映射不用动。

- **归 #18 实施发现的遗留（不在本票范围）**：
  - **单道换菜（`replace` + `manual`）不留 LLM 元数据**。理由：单道换菜走的是整份菜单 `PUT`（与手动改餐同一条路），它可能改变任意多道菜，因此「这一条换菜事件是哪些 LLM 调用造成的」无法忠实重建；写半分元数据比不写更糟（看起来能回溯，实际是假证据）。要可回溯就得把「一次换菜」升成一个专门的动作 + 事件，那是后续工单的事。整餐推荐的 `replace_set` **照旧带全套元数据**（那个调用确实造成了整套菜单）。
  - **候选池的「同位」只到荤/素/汤位，不区分荤汤/素汤**（总纲 §2.8 的汤分荤素只为忌口）。所以换一道荤汤可能给一道素汤——结构上不算变（都是汤位），但口味可能变；若之后要锁「荤汤换荤汤」，那是在 `llm/recommendation-schema.ts` 的 `positionOf` 之外再加一层更细的分位。
  - **`excludeDishes` 的闭包 `slotId` 不重置**（来源：#18 末轮复审，低危、当前不可达）。`web/src/routes/SlotView.tsx` 用 `setSession({ slotId, excludes: [...(current.slotId === slotId ? current.excludes : []), ...] })` —— `slotId` 来自闭包而非 updater 入参，若某天出现「不经 HomeView 的 A 槽 → B 槽 → A 槽」客户端路由（组件实例不卸载），A 的旧排除集会被复活；`sessionExcludes` 的**读**已按 slotId 匹配，所以只是写入侧不严谨。当前 UI 离页必经 HomeView（卸载即清），**不可达**。若日后加餐槽间的直接导航，把不可靠的闭包捕获改为在 effect 里按 slotId 重置。
  - **家规常量未落表**（`DEDUPE_DAYS` 已被候选的池干放宽复用）。
    ✅ **已由 #20 处理的部分**：餐次截止时刻（原 `domain/family-time.ts` 的 `MEAL_CUTOFF_HOUR`）与冷藏天数（`cool_off_days`，默认 14）已落 `family_rules` 单例表（迁移 006），运行时读表（`domain/family-rules.ts`），原常量已删除。
    **剩余部分归 #26 收口**：`server/src/domain/recommendation.ts` 的 `BASELINE`（2 荤 1 素 1 汤）与 `BASELINE_ADULTS`、`DEDUPE_DAYS`（7）、`LLM_TIMEOUT_MS`（30s）、`MIN_FAMILY_PER_POSITION`（3）、`MAX_FAMILY_PER_POSITION`（8）仍是实施者自定常量，spec §2.2/§4 说这些属家规（“家规可调”）。落点是 #20 建好的同一张 `family_rules` 表（追加列即可，代码里几处 TODO 已标注），并同时把 `web/` 里的显示值一并改成读表（不把 7 天/基线个数硬编码进文案）。
    ⚠️ **别把「可写性」与「搬常量」混成一件事**：本行说的是**把那六个常量搬进表**（归 #26）。
    至于**已有值的可写口**：冷藏天数（`cool_off_days`）的编辑入口归 #26；而**留量上浮系数与两个
    餐次截止时刻**已由 #23 评审修复 ① 开放为可写（`PATCH /api/family-rules`）——理由是它们会改变
    清单该含哪几餐/克数，不开放就没办法在它们变时标清单过期（`server/src/api/family-rules.ts` 的注释）。
  - **「换菜会话」的边界是「不离开槽位页」**。会话排除集活在 `SlotView`/`HomeView` 的组件状态里（`SlotView` 那份刻意提到外层、不随 `key` 重挂载，`e2e/replace.spec.ts` 有回归用例）；但保存会 `navigate('/')` 离开，回同一页再换菜时排除集归零。判断：这与「一轮换菜 = 页面生命周期」的口径一致（已定菜单本身也没变成别的东西），**保留**。若日后要求「保存后回同一页仍累积」，得把会话提到路由之外（`sessionStorage` 或提升到 `App`），属语义变更。
  - **`bookSlot` 的 `sameMenu` 短路与撤销的交互**（来源：#18 复审）。连续两次「换一整套」拿到**完全同一套**菜单时不会追事件（`slots.ts` 的 `sameMenu` 判定），于是 `canUndoSet` 仍指向更早那套——用户刚点的那一下被「跳过」了，撤销会跨过它。判断：`sameMenu` 短路是 #17 的既有语义（防手机双击写两条重复留痕），**不在本票改**；真实触发条件苛刻（LLM  temperatura 0.7 + 确定性 fake 才容易复现），若要修应把「换一整套」与「保存改动」的短路分开判定。

## 归属 #19（冷启动导入工具）

- **菜系参考 tag 未落**（来源：#15 审查）。§2.8 要求「口味封闭五标签（多选）+ **菜系参考 tag**（导入时 LLM 初打、转正时掌勺者校对）」。全库无 `cuisine` 字段/列。issue #15 的 AC 未列此项，但 §2.8 明确它的产生时机是「导入时」——正是 #19 的活。**#19 需补：`recipes.cuisine` 字段 + 导入时 LLM 初打 + 转正时校对（#21）。**
  - ⚠️ 注意：`003_portion_engine` 已建立「年龄分带与 WS/T 554 对齐」的先例，同理菜系 tag 若与 `recipe_tastes` 并存，要避免两套分类打架。

## 归属 #19（冷启动导入工具）

- ✅ **菜系参考 tag 已落**（来源：#15 审查）。本票补了 `recipes.cuisine` 列（迁移 005）：
  单一列 + CHECK 白名单（川/粤/鲁/苏浙/湘/东北/闽/徽/西北/京/家常），**不给它建多值表**——
  它与 `recipe_tastes`（口味封闭五标签）值域互不相交，两套分类不会打架；它**不参与过滤与判定**，
  只是菜谱详情里给家人看的一句参考。导入时由 LLM 初打（`llm/import-schema.ts` 的 `classifyCuisines`，
  值域白名单与 CHECK 同源），失败就保持 `null`——**转正时掌勺者校对归 #21**（本票不做校对 UI）。

- **外部池的 0 克项是「待重标」而不是错误**（本票新增的存储约定）。`recipe_ingredients.adult_grams`
  的 CHECK 从 `> 0` 放宽为 `>= 0`（迁移 005 重建了这张表，与 002 重建 `member_loves` 同一路数）：
  **0 = 模糊份量待 LLM 重标**。谁会读到它、谁该绕开它是接下来要记得的事：
  - ✅ **推荐/换菜候选池这一侧已由 #19 收口**：`hasPendingRelabel`（`server/src/domain/recipes.ts`）
    是唯一判定处，`recommendation.ts` 的外部补位池与 `replacement.ts` 的候选池都过它——
    含 0 克项的草稿**不进候选池**（它乘出来就是 0 g 进合计），重标写回正数后自动回来。
    测试：`server/src/api/recommendations.test.ts` 与 `replacements.test.ts` 的「含「待重标」项（0 克）
    的草稿不进池；重标成正数后能回来」两条。
  - #22/#23：份量/买菜聚合遇到 0 克项要**显式处理**（它表示「这个食材在菜里，但克数还没定」），
    不能当零克食材静默跳过。推荐入口已把这类草稿拦在外面，所以正常路径上聚合不会再遇到 0 克；
    但家庭菜谱被手改成 0 克、或 #21 转正前后状态交叠时仍可能遇到，届时要有态度（列出来 / 报待重标）。
  - #21（转正）：掌勺者校对的界面要把「待重标」标出来——那是导入进来的菜与家里确认过的菜
    最实质的差别之一（转正前必须先把 0 克重标掉，否则转正会把一个未定的克数固化成家庭基准）。
  - 当前影响面：没开 `--llm` 的导入（或 LLM 抽风的那些批次）会在库里留下 0 克项，
    报告里的 `relabel.pending` 会全部列出（不会静默，且带**份量原文**当证据）。
  - **真数据实测**（调度层用真库查过）：导入后 435 个 0 克项里有 196 个是主料（虾、草鱼、鸡肉、鸡蛋、柠檬…）、
    239 个是调料——所以这条收口不是纸面风险，是真实影响面。

- **归一失败清单里的「真缺字典」项**（来源：本票真实数据跑批）。HowToCook 372 篇里
  仍有约 250 条食材名对不上字典（如 `印度综合香料粉`、`白芷`、`酥油`、`葱结`、`
  野山椒`）。它们是**不同语境下真的需要的食材**，不是杂讯：
  - 按需补字典（每补一个别名，报告里那种名字就少一条）；
  - 补录动作应该带一条**回填脚本/迁移**（本票没做：导入报告已把它们按出现频次排序列好了）。
  - 📌 **方案已定（2026-09-20 grilling 会话，见下节「外部池观察轮」）**：254 条已四分类（44 杂讯 /
    错别字 alias / 粒度断层 / 真缺长尾），模型决策为「扁平 + 三件套」——不引入 parent_id 层级。

- **下厨房热榜的实测降级**（来源：本票真实取数）。站点对连续详情页请求回 **HTTP 429**：
  `fetch:xiachufang` 用 `--delay`（缺省 1.2s）节流，仍可能只取到 4–7 条。
  **这正是 ADR-0006 说的「轻量抓」**：抓到多少算多少，来源如实标 `scraped`，抓不到就降级
  （脚本退出码 1 + 一句人话；`--from` 那一路不受影响）。
  要更稳就得换数据源或加缓存，**不要**引入 headless 浏览器（那是把许可风险与复杂度一起放大）。

## 归属 #20（反馈、餐后回顾与冷藏期）

- ✅ **`MEAL_CUTOFF_HOUR` 家规化**（来源：#15、#16 审查）。已落：`family_rules` 单例表
  （`lunch_cutoff_hour` / `dinner_cutoff_hour`，迁移 006，默认午 14 / 晚 21），运行时判定读表
  （`domain/family-rules.ts` 的 `familyRules` + `domain/slots.ts` 的 `hasMealPassed`——
  签名多了 `db`）。原常量已从 `domain/family-time.ts` 删除（不留会与库漂移的副本），
  只在那里留了一句指向家规表的注释。`GET /api/family-rules` 是读口。
- ✅ **快捷标签定义**（总纲 §2.5）与「餐后回顾」UI 入口。已落：封闭四值
  （太油/太甜/量太多/量太少；`FEEDBACK_TAGS` 与迁移 006 的 CHECK 同源）、
  反馈条组件 `web/src/components/FeedbackBar.tsx`（菜单卡 + 回顾卡共用一套），
  回顾页 `web/src/routes/ReviewView.tsx` 由底部导航的「回顾」标签常驻进入（不弹窗不推送）。
- ✅ **反馈摘要接进 `recommendMeal`**（台账「归属 #17」那条）。`recommendMeal` 与 `findCandidates`
  都传 `feedbackSummary(db, clock)`（近 30 天；点赞写成句子，**带标签的反馈不论赞踩都把标签文本聚进摘要**
  ——标签回答「为什么太油/太甜/量太多」，冷藏期的布尔答不了这个问题，而冷藏期那条硬排除照旧只认点踩）。
  两条 prompt 模板因此各 +1 版本（`2026-09-rec-v2` / `2026-09-candidate-v2`）——旧版本号已从
  留痕校验里移除（`slots.test.ts` 改成从 `PROMPT_VERSION` 读）。
  （评审修复轮改的就是这一条：原先只有点赞行的标签进摘要，而界面上唯一能选标签的两条路产出的标签
  会被 `verdict !== 'like'` 全部丢掉——菜单阶段点踩 + 标签的路径等于白选。）

- **#22 接**：家规表已建好（`family_rules`，单例，迁移 006），它加留量上浮系数直接 `ALTER TABLE ... ADD COLUMN`
  即可（或另建一列，形状不变）——但**本票没有**建家规的写接口（只读），也没有把
  `recommendation.ts` 的 `BASELINE` / `DEDUPE_DAYS` / `LLM_TIMEOUT_MS` 搬进去：那是 #26 的统一收口
  （代码里已标 TODO）。

## 归属 #21（转正流程）

- ~~**迁移编号 007 留空**（#21 实施时的记注）：#21 的台账迁移是 `008_recipe_promotions`。~~
  **已过时**（#22 集成时 `007` 被 `007_leftover.sql` 占用）：现在的版本号是连续的
  `001`–`008`，不再有洞。执行器本来就只按版本号字典序、不要求连续（`db/migrate.ts` 的 `^\d{3,}`）。

- **008 新增了一条待重标种样张（不是改 004 的行）**（#21 实施，接 #19 的欠账；**评审修复轮**改成这个形状）：
  `008_recipe_promotions.sql` 末尾种下一条**本票自己的**草稿菜「土豆炖排骨（待重标样本）」
  （id `pending_relabel_ribs`），主料排骨 `adult_grams = 0` + `source_quantity = '适量'`（原文当重标证据），
  土豆/姜/生抽克数齐全——是一个「部分待重标」的真实形态（真实数据里 196/435 的待重标项是主料）。
  理由：004 的九道种子草稿**全都是确切克数**，于是「待重标」在种子库里一个样本也没有，
  而 #19 台账点名「#21 的掌勺者校对界面要把待重标标出来」。它同时是转正改写那条校验
  （待重标必须被重标）与 E2E 待重标标记的现成数据。
  **为什么不是 UPDATE 004 的家常豆腐**：004 的种子是别的票刻意铺的（含忌口样本、季节样本），
  改既有行会产生跨票影响，也违反 `server/migrations/README.md` 的「迁移里只种规则资产与字典、
  不碰别人的行」这条纪律。新增一条自己的样张代价很小，而例外会累积；
  另有 `schema-008.test.ts` 钉住「008 不碰 004 的任何行」。
  **副作用要记得**：它带 0 克项 → 不进推荐/换菜候选池（`hasPendingRelabel`）——正是真实导入后
  未重标的草稿的样子。`server/src/domain/library.test.ts` 里一条写死 `pending` 全库条数的断言
  已改成只看本次导入那道菜（相对断言，写死计数必坏）。
  #22/#23 若要在份量/买菜里处理 0 克（台账「归属 #19」最后一条），现在有现成数据可测。

- ✅ **已由 #21 处理**：`dad-loves-entry-${id}` 丢 kind 的脆弱点（来源：#14、#15 审查）。
  `web/src/routes/FamilyView.tsx` 的三处 testid 全部带上 kind（`${member.id}-loves-entry-${entry.kind}-${entry.id}`、
  `-loves-remove-<kind>-<id>`、`-loves-suggestion-<kind>-<id>`），`e2e/family.spec.ts` 的八处引用同步更新。
  转正新增的菜谱 id 现在不会与食材 id 撞车。

- **外部菜谱转正后，那道菜的历史 "外部来源" 标记就看不见了**（来源：#21 实施，判定为**刻意不改**）。
  转正就地改写同一行（`recipes.source` 保持 `howtocook`/`scraped`/`llm` 不变），但界面上
  「没做过」标记只看 `origin`（草稿=external）——转正后它成了家庭菜，标记自然消失。
  这是对的（「没做过」说的是「家里做过这道菜没有」，不是「这菜谱从哪来」），但**「这道菜的原始出处」
  在全库没有展示位**：`GET /api/recipes` 会给出 `source`，界面没有用它。若日后要一道
  「来源与转正史」的详情页，账本表 `recipe_promotions` 已经在（`GET /api/recipes/:id/promotions`），
  接着做即可。

- **转正表单的菜系选项表是手抄的**（来源：#21 实施）。`web/src/routes/ReviewView.tsx` 的
  `CUISINE_OPTIONS` 与 `server/src/llm/import-schema.ts` 的 `CUISINES` **值域同源但两份代码**
  （ADR-0002 只放开类型导出，运行时常量不能 import；`FeedbackBar` 的 `FEEDBACK_TAG_OPTIONS`
  是同一处理）。漂移会表现为「界面能选、服务端 400」，有挡住的风险但没有静默错的路径。
  #26 若要把「同一份值域」收口成构建期校验（如从 server 导出 `as const` 后经类型断言约束），
  这里是一个现成的小改造点。

- **`ReviewView.tsx` 职责过宽**（来源：#21 评审的 Divergent Change，**本票刻意不拆**）。
  该文件同票承担四件事：回顾渲染（#20 的页面）、转正表单（#21）、菜系选项表（#21）、
  转正台账回执（#21）。#21 只是往 #20 的页面里**加**了后三件，拆它会与 #20 的页面纠缠
  （回顾卡、反馈条、身份都在同一个渲染树里）。所以登记在这里：**若要拆，应作为独立的重构票**
  （建议的切法：`PromotionForm` + `PromotedReceipt` + `CUISINE_OPTIONS` 提到
  `web/src/components/Promotion*`，`ReviewView` 只管回顾），并补上对应的组件测试/走查。
  另一条同一来源的判记：`api/recipes.ts` 的 `promotionError` 与 `api/feedback.ts` 的
  `feedbackError` 都映射 `unknown_member`，**有意不共用**（与 `portionError`/`bookingError` 同口径：
  错误体字段随路由而变）——两处都已加注释。

- **两种 0 不要混**（来源：#21 实施 + 评审修复轮，已收口到一处口径）。
  库里的 `adult_grams = 0` **只有一个含义**：模糊份量待 LLM 重标（迁移 005，原文存 `source_quantity`）。
  转正路径从不往库里写「确认不放」——掌勺者说「不放蒜」时，改写出参里该项是 0，落库时**该项被丢掉**
  （`domain/promotion.ts` 事务第 ④ 步：不做的食材就不在清单里）。所以「重标成 0（结论）」只活在
  转正改写的那一次出参里，与库里的 0（欠账）是两种语义。`validateRewrite` 要求输入的 0 克项变正数，
  **唯一例外**就是掌勺者口述明确说了不要（「不放蒜」→ `droppedByDictation`）。
  它靠口述原文包含匹配（「不放+词」），真实场景里说法的花样可能匹配不上——
  匹配不上就是**保守地拒绝**（502，草稿留着让掌勺者重说），不会把未定写进家庭基准。

## 归属 #22（留量）

- ✅ **留量上浮的家规化**（来源：本票实施）。`LEFTOVER_UPLIFT` 常量已删除，系数改为读
  `family_rules`（迁移 007 给 006 的表加列，`leftover_uplift` 默认 1.5，CHECK 1–5），读取口在
  `server/src/domain/family-rules.ts`（`familyRules(db)` / `updateFamilyRules(db, clock, patch)`；
  只读单个字段就用 `familyRules(db).leftoverUplift`，不为它单留一个转发壳），写入口是 `PATCH /api/family-rules`。
  份量引擎（`domain/portion.ts`）在算每道菜时读它。
  ✅ **集成注记（已处理）**：#20 并行实施时也建了 `family_rules` 表与同名的 `/family-rules` 路由
  （冷藏期 + 餐次截止），两条分支互为不可见（都基于 `01b6766`）。**合入 main 时已由调度层合并成
  一张表、一个读取口、一个路由**（列求并集，仍是 id=1 单行）：007 **不再建 `family_rules`**，
  改为 `ALTER TABLE ... ADD COLUMN leftover_uplift` 给 006 那张表补列（006 仍建表种行，两个文件都
  没改历史）。

- ✅ **UI 不得显示未兑现的倍数**（来源：本票实施）。上浮现在真的会生效了，所以倍数可以显示回来
  ——但**从线上数据动态读**，不硬编码：`web/src/routes/HomeView.tsx` 与 `SlotView.tsx` 都读
  `portion.uplift` / `dish.uplift`。这两个字段报的是**实际生效**的系数（留量标记 ∧ 有效引用
  两道门都过了才是家规系数，否则恒 1），所以界面不会标的数比算术大。
  家规的**配置值**另有 `GET /api/portion/rules` 的 `rules.uplift`（未兑现也能看见配置是多少，
  但界面不拿它当读数用）。

- **本票实现的两条不变量与联动**（同属 #22 本体，记在这里便于日后回归时对齐）：
  - 上浮生效 = 留量标记 ∧ 有效引用（总纲 §2.6）；四个组合见 `server/src/api/leftover.test.ts`
    的「留量上浮的不变量」describe。
  - 取消被引用的午餐 → 引用方晚餐槽**追加一条 cancel 事件**退回未定，`DELETE /api/slots/:id`
    响应里的 `released[]` 报出被退回的槽（总纲 §3 决议 4）。另补了一条对称的情形：
    改午餐把留量标记**全拆了**时引用同样失效，晚餐也会被退回（否则它会停在「已定 + 零道菜」）。
  - 「吃剩的」那一餐**没有自己的菜品快照**，菜从被引用那一餐的 `keep_leftover` 现推导
    ——中午改了菜，晚餐跟着变。
  - `POST /api/portion/preview` 的 `slotId` **必须是个真餐槽**：非法/不存在的 id 一律 400
    `invalid_slot_id`（不是静默按「无引用」算一份少乘系数的读数）。不传仍是草稿（无引用）。

- **「绿叶菜不留」= 明确不做（解释性背景，非过滤规则）**（来源：本票评审）。spec §2.6 与
  `CONTEXT.md` 的「留量」词条都写着「**绿叶菜不留**」，但数据模型里**没有任何「绿叶菜」属性**：
  唯一相关的字段是 `meal_event_dishes.keep_leftover`（一个布尔列），而 `leftoverSourceOf` /
  `resolveDishes` 只对它做过滤与透传，**不看菜谱的 `kind`**。于是素位与汤位的菜（如蒜蓉菜心、
  冬瓜排骨汤）都能被标留量并上浮——**这就是既定行为，不是缺口**。
  **用户已拍板：不做。** 那句「绿叶菜不留的现实 → 留量是单道级」是在解释**为什么留量按单道而不是
  整餐**这个设计选择，不是一条要实现的过滤规则；AC 原文「单道留量标记」已实现，无功能缺口。
  两条候选口径都被否决：按 `RecipeKind` 的素/汤位一律不可留（`veg` / `soup_veg`，无需迁移）
  **过宽**——红烧土豆也是 `veg`，且「午餐的汤留到晚上热一热」是这个家的正常做法，堵掉它比现状更糟；
  引入真正的绿叶菜标记（迁移加列/关联表 + 初始名单）则精确但**要先有一份「哪些算绿叶菜」的名单**，
  那属于菜谱库的属性扩充，性质上是新工单而不是本票的收尾。
  **若日后真要做**：先补那份名单，并配套一条纪律——不可留的菜在界面上要**看得见原因**（照仓库既有
  纪律：排除原因必须可见）。

## 归属 #23（买菜清单）

- ✅ **买菜清单已交付**（本票实施）。实现面：迁移 `009_grocery_list`（三张表）、
  领域 `server/src/domain/grocery.ts`、路由 `server/src/api/grocery.ts`（`GET /grocery` /
  `recalculate` / `archive` / `items` CRUD）、页面 `web/src/routes/GroceryView.tsx`
  （`/grocery` 替掉占位页）、测试 `server/src/api/grocery.test.ts`（21 条）+ `e2e/s8-grocery.spec.ts`（4 条）。

- ✅ **B/C 视图里买菜入口仍指向占位页**（来源：#24 实施）。三视图共用底部导航（`TabBar`）：
  #23 用 `GroceryView` 替掉 `Placeholders.tsx` 的 `GroceryView` 之后，A/B/C 三套视图自动都有；
  **没有**在视图层各做一套（台账原话：「无需在视图层各做一套」）。

- ✅ **S1 的 E2E 跨票缺口已补完整**（来源：#17 审查）。
  `e2e/s8-grocery.spec.ts` 的「S1 补完」用例走完 §1.2 S1 的完整通过标准：
  打开首页 → 点「给我推荐」→ 一键接受 → 底部导航进买菜清单页 →
  **逐食材断言清单的克数与 `GET /api/slots/:id` 内嵌的 `portion` 读数一致**（不是「看见几个字」），
  且生熟换算参考在场。

- ✅ **WS/T 554 表 3/4「每餐克数」未录（判定照建议执行：不录）**（来源：#16 审查，本票确认）。
  清单按**菜谱食材生重聚合**（§2.7），份量一律问份量引擎（`portionOf`），确实不依赖表 3/4；
  与已录的「宝塔推荐量篮 × 餐次占比」重叠，再录一份只会漂移。本票没有实现需要「每餐建议量」
  做校验/提示的功能，所以**不录**。若日后要做「今天吃得合不合理」这类提示，再按需录。

### 本票实施中发现、有意不在本票处理的项

- **「不凭空重建已归档的清单」用**聚合指纹**判（本轮新增的语义）**。
  `GET /api/grocery` 在没有进行中清单时会现物化一份；但若最近一份已归档清单的聚合指纹
  （食材 + 克数 + 来源逐项）与当前菜单一致，就不重建（否则「归档 → 刷新页面」会立刻冒出一张
  内容相同、勾选被洗掉的新清单，看起来像归档没生效）。指纹由 `signatureOfItems` /
  `signatureOfRows` 现算，不另存一列。**日后若给清单加列（比如备注、价格），指纹要一并考虑**
  ——加的是「聚合结果」的一部分就进指纹，加的是「清单私有的东西」（像手工行）就不进。
- **聚合口径：只算「今天及以后 ∧ 已定 ∧ 还没过截止时刻 ∧ 不是『吃剩的』」的餐**。
  不复用 `listUpcomingSlots`（那是「下一餐优先」的展示窗口，带一个随便定的天数）——
  清单的窗口按「订到哪天就买到哪天」取（`buyableSlots` 直接扫事件流）。
  **若日后要一个「只看未来 N 天」的清单**，那是家规/筛选，不是聚合口径的修正。
- **过期原因存结构、不存中文（评审修复 ②）**：`grocery_lists.stale_reason` 是**枚举短码**
  （`menu_changed` / `cancelled` / `set_undone` / `family_rules_changed`），`stale_slot_id`
  说「哪一餐」（家规类为 NULL）。界面那句「⚠️ （今天午餐的菜单变了），清单过期了」在前端现拼
  （`web/src/routes/GroceryView.tsx` 的 `staleReasonText` / `mealLabel`）。
  两条不变式由迁移 009 的 CHECK 钉死：槽位类原因必带槽、家规改动必不带；原因值域封闭。
  **新增会改变聚合的写路时，领域层的 `StaleReason` / 迁移的 CHECK / 前端的 `staleTail`
  三处要一并加一档**，否则清单会静默不过期。
- **家规改动会标清单过期（评审修复 ①）**：`PATCH /api/family-rules` 改了会进聚合的值
  （`leftoverUplift` / 两个截止时刻）时标 `family_rules_changed`；判据在领域层一处
  （`domain/grocery.ts` 的 `familyRulesAffectGrocery`）。冷藏期天数不影响清单，改它**不**标。
  日后新增家规值进聚合路径时把它加进那个判据。
- **「标过期」与「菜单/家规写入」同事务（评审修复 ⑤-2）**：路由层包一层 `db.transaction`
  （领域层自己的事务在里面自动降级成 SAVEPOINT）。窗口原本极小（同一 tick 内），
  但代价只是一层包装，买的是「不会留下菜单已变、清单未过期」这种静默不一致。
- **「今天/明天 + 午/晚餐」文案只有显示层一处（评审修复 ③）**：服务端只下发结构
  （来源的 date/meal、`stale_slot_id`）与 `/api/grocery` 的家庭时区 `today`；
  服务端的 `slotLabel` 已删（② 之后它再无调用点）。
- **聚合指纹不含手工行（评审 ⑤-3，判断：记台账、不改行为）**：指纹比的是「聚合结果」
  （食材 + 克数 + 来源），手工行是「清单私有的东西」——不是聚合的函数，本来就不该进指纹。
  于是「归档后菜单没变、只想再加一条手工行」时 `GET /api/grocery` 返回 `null`（界面是空态），
  要写一行才会物化一张。判断：**这是对的形态**——空购物车没有信息量，而手工行卡恒在、
  写一下就建单（`activeListOrCreate`），多一步不多；若把手工行也当「菜单变了」的信号，
  「归档 → 刷新」就会因为上次留下的手工行而反复重建清单，那才是真问题。
  **日后若有人抱怨这一下多余**，优先改 GET（把「最近归档那份有手工行」也当不重建的理由）
  而不是改指纹。
- **`readGroceryError` 与另外三份 `readErrorDetail` 有意保留（评审修复 ④）**：交集只有
  `invalid_request`，其余错误码随路由而变（`itemId` / `aggregate_item_not_deletable` 只属 grocery）。
  与台账「`portionError` 与 `bookingError` 的映射重复（有意保留）」同一口径，代码注释里已写明。
- **副作用在 GET（评审 ⑤-4，判断：保留不改）**：`groceryList` 在 `GET /api/grocery` 里
  insert 一张清单。这是总纲 §2.7「物化实体」的直接后果——物化的时机只能是第一次读；
  换成写接口（如 `POST /api/grocery/open`）会多一个前端必须记得调的动作，
  而忘了调就是「定了餐但清单页空着」。代码注释已自辩（`domain/grocery.ts` 的 `groceryList`
  两条不走物化的路 + `wire-types.ts` 的 `GroceryListResponse`），**保留**。
- **`slotLabel` 的 export 已随 ② 一并消除（评审 ⑤-1）**：它全仓唯一调用点就是自己的文件，
  ② 把渲染改到前端后它再无调用点，于是连同 `mealLabel` / `nextDate` 一起删掉
  （不是「去掉 export」，是整段不存在了）。
- **`needsRelabel` 标记已录**（来源：台账「归属 #19」点名 #23 要有态度）。
  导入期的 0 克项（模糊份量待 LLM 重标）**列出并标记**（`⌛ 待重算`）而不是静默跳过：
  0 g 不是「不需要买」而是「还不知道买多少」。重标写回正数后重算一次，标记自然消失。
  测试：`server/src/api/grocery.test.ts` 的「0 克项（导入期「待重标」）列出并标记」。

## 归属 #25（部署与备份）

- ✅ **五条 AC 全部落地并实测**（spec §7、S10；实测记录见 `docs/deploy/README.md`）。
  实现面：`server/src/deploy/`（`paths` / `launchd` / `backup` / `backup-cli` / `backup-cli-entry` /
  `nginx` / `nginx-include` / `secrets` / `install` / `deploy-cli`）、片段 `deploy/nginx/dinner-location.conf`、
  入口脚本 `pnpm deploy:install|uninstall|status` + `pnpm backup`、测试 66 条
  （`server/src/deploy/*.test.ts` 与 `scripts/backup.test.ts`，共 71 条）。

- **⚠️ 决定性发现：一个进程只能有一个 `BASE_PATH`，所以 S10 的两条通道需要两个实例**
  （来源：#25 实施，本票最重要的一条）。S10 要求「经 nginx 子路径」与「直连 `http://<host>.local:8787`」
  **两条都可用**，但 `BASE_PATH` 是启动配置：`=/apps/dinner` 时直连根路径 404；
  `=/` 时 nginx 侧的前端会去请求根路径的 `/api/*`，而那个 location 在本机 8080 上**属于 pi-web**
  （实测「剥前缀」写法需要额外补 4 条 location 才能跑通，其中 `/api/` 会抢别人的流量）。
  **⚠️ 同一发现里的一处实测更正**：剥前缀写法**确实可用**，但需要额外 4 条 location，
  且 `proxy_pass` **必须不带路径**（带路径时 nginx 用那个 URI 替换匹配到的 location 前缀，
  `/assets/x.js` 会变成 `/x.js` → 上游 404；实测踩过一次，第一版记录里的写法是错的，已更正）。
  6 条路径（入口/API/manifest/assets/icons/深链）在隔离端口 17991 上逐条实测 200，
  记录进 `docs/deploy/README.md` 的「两种 nginx 写法」与实测表。**它在本机不可用的唯一原因**
  是 `location /api/` 已属于 pi-web（会抢流量），不是兼容性问题。

  **决议（用户拍板）**：两个 launchd 实例，共用同一个 SQLite 文件（WAL 支持多进程读写，
  写锁竞争由 `db/index.ts` 的 `busy_timeout = 5000` 兜）——
  `com.naoki.dinnerorder`（8787、`BASE_PATH=/`）+ `com.naoki.dinnerorder.subpath`（8786、`BASE_PATH=/apps/dinner`）。
  **这偏离了 spec §7「一个 plist 指 `node dist/server/index.js`」的字面**（那句默认单实例），
  但两条通道同时可用是 S10 的硬要求，二者不可兼得时选了后者。
  ✅ **已记 ADR-0008**（`docs/adr/0008-two-instances-per-access-path.md`）：含完整取舍、
  被否决备选、以及与 ADR-0002/0003 的关系（**ADR-0002 不被推翻**——每个实例仍是单进程前后端一体；
  **ADR-0003 被强化**——同一份构建产物挂两个路径，正是运行时注入想要的效果）。
  审查指出「偏离 ADR 未记录」后补的。若不接受双实例，代价最小的退路是让直连也带前缀
  （`http://<host>.local:8787/apps/dinner/`，改 plist 的 `BASE_PATH` + 文档，**无需改代码**）。

- **宿主 nginx 只加一行 include，片段本体留在仓库里**（来源：#25 实施）。
  `servers/apps-proxy.conf` 是用户手写的、服务 pi-web / mdtools / baby / frame / qqmusic 的文件；
  装机只往里插一行带标记的 include（`# dinnerorder-location`，幂等且可撤），片段本体
  `deploy/nginx/dinner-location.conf` 受版本控制。实测 diff 就两行（一行 include + 一个空行）。
  **`servers/*` 是 http 上下文**（`include servers/*`），所以裸 `location` 放在那目录下会报
  `"location" directive is not allowed here`——两种形态（location 片段 / 自带 `server {}`）在
  `nginx.test.ts` 与 `nginx-include.test.ts` 分别钉住。
  **插入位置用大括号配平算**（`nginx-include.ts`）：那个文件里有引号含 `{}`/`#` 的字符串与注释掉的花括号，
  正则一把梭会插错位置。

- **`--dry-run` 曾真的写了系统**（来源：#25 实施，自测逮到）。第一版 `deploy-cli.ts` 在 dry-run
  分支里自己拼步骤列表、没调 `install(plan, {dryRun:true})`，于是「空跑」照样装了 plist 与 nginx 片段。
  **已修**：dry-run 与真装走**同一条判断路径**（`install(..., {dryRun:true})` 返回计划、不碰文件系统）。

- **`bootout` 是异步的，紧接着 `bootstrap` 会报 `Input/output error`**（来源：#25 实施，重装幂等测试逮到）。
  `launchctl bootout` 返回 0 只代表命令收到，服务可能还在退；此时 `bootstrap` 报
  `Bootstrap failed: 5: Input/output error`——**这句话完全指不到真因**（看起来像权限问题）。
  **已修**：`loadAgent` 在 bootout 后有界轮询到 `launchctl print` 真的失败为止（上限 10s）。
  重装幂等因此可测：连装两次都能成功。

- **`.backup` 会继承源库的 `journal_mode = WAL`，于是备份目录会堆 `-wal`/`-shm`**
  （来源：#25 实施，恢复演练时发现）。源库是 WAL，`.backup` 输出也是 WAL；
  任何人打开备份文件（包括恢复演练）都会在 `backups/` 里留下侧文件，而它们**不匹配**
  `dinner-YYYY-MM-DD.db` 这个形状 → 滚动保留不会清 → 日子一长堆满垃圾。
  **已修**：备份后立刻 `PRAGMA journal_mode = delete`（冷藏快照不需要并发写），并清掉侧文件
  （连 `.tmp` 那一步产生的也清）。回归测试两条钉住：「打开备份后目录里只有一份 .db」
  「滚动删日期时连同侧文件一起清」。

- **既有测试对真实系统有副作用，需要在 #26 注意**（来源：#25 实施）。
  `src/deploy/*.test.ts` 里只有纯逻辑与 `plists`/`nginx -t` 这类**只读**断言进单测；
  `launchctl bootstrap` 与 `tmutil addexclusion` **有意不进单测**（会污染跑测试的机器，
  在别人机器/CI 上结果还不同）。那两条由装机实测负责（`docs/deploy/README.md` 有记录）。
  **#26 若在别的机器上跑 `pnpm test`，`deploy` 那 66 条应当全绿**（它们不碰系统状态）；
  但 `install.test.ts` 有一条「找得到 Homebrew 的 nginx servers 目录」，在没装 nginx 的机器上
  走的是 `dir === undefined` 的分支（断言写成了二选一，不会红）。

- **审查修复轮（两轴审查发现，均已处理）**（来源：#25 评审）：
  1. **剥前缀写法的实测记录缺失且**写法是错的**（Spec 轴 AC2 指出）。第一版把
     `proxy_pass http://upstream/assets/` 当成对的了——实测 `/assets/x.js` → `/x.js` → 404。
     正确写法是 **`proxy_pass` 不带路径**（不带 URI 时 nginx 原样转发；带 URI 时用它替换匹配前缀）。
     现已 6 条路径（入口/API/manifest/assets/icons/深链）在隔离端口逐条实测 200，
     写进 `docs/deploy/README.md`「两种 nginx 写法」与实测表。
  2. **卸载把 `.env` 的 Time Machine 排除撤掉了**（Spec 轴指出，**真 bug**）。`uninstall` 原先调
     `removeTimeMachineExclusion`，而 `.env` 仍在盘上（`kept` 里声明保留）——撤销排除等于把密钥放回
     整机备份，正违反 spec §4「排除出双通道」。**已修**：卸载只**重新确认**保留项的排除状态
     （`retainedExclusions`），不再撤销；测试三条钉住。
  3. **`removeTimeMachineExclusion` 恒返回 `false`**（Standards 轴指出）：卸载报告永远显示「未排除」，
     与实情无关。该函数已随第 2 条整体删除。
  4. **卸载/回滚会删掉受版本控制的片段文件**（Spec 轴指出）。`uninstallFromExistingServer` 原先
     `fs.rmSync(deploy/nginx/dinner-location.conf)`——那是仓库文件（删它会让 `git status` 冒出一个意外删除）。
     **已修**：只撤 include 行，不删片段；测试两条钉住。
  5. **两个错误的注释路径**：`server/src/deploy/nginx.ts` 与 `backup-cli-entry.ts` 的头注里
     把文件位置/入口名写错了（Standards 轴指出），已改对。
  6. **死导出与魔法数字**（Standards 轴指出）：删掉 `countRowsInBackup` / `backupTargetDir` /
     `nginxFragmentPath`（全仓无调用），`deploy-cli.ts` 的 `7` 改用 `KEEP_DEFAULT`，
     端口校验收成 `parsePort()`，`LaunchAgents` 目录复用 `launchAgentsDir()`，
     `deploy:status` 的输出从**已装载的 plist 现读**端口与挂载点（不再硬编码 8787/8786）。
  7. **`InstallPlan` 与 `PlistOptions` 字段重复**（Standards 轴指出）：改为类型别名复用。
  8. **`deploy/tm-exclusions.txt` 不该入库**（两条轴都问过）：内容是本机绝对路径、每次装机重生成，
     已加进 `.gitignore`。
  9. **偏离 ADR 未记录**（Spec 轴指出）：新增
     [`docs/adr/0008-two-instances-per-access-path.md`](../../docs/adr/0008-two-instances-per-access-path.md)，
     写明取舍、被否决备选、与 ADR-0002/0003 的关系。
  10. **AC5 缺 plist 示例**（Spec 轴指出）：`docs/deploy/README.md` 补了两个 plist 的关键片段
      与三个 key（`KeepAlive` 字典型 / `RunAtLoad` / `EnvironmentVariables`）的用意说明。

- **一个间歇性失败的测试（自己写的，已根治）**：`backup.test.ts` 的「正在被写着的库也备得到最新数据」
  偶发红（12 轮里 3 次），**根因有两层**：
  1. 轮询用的是忙等 `while (Date.now() < until) {}` —— 并发跑到 CPU 饱和时会把 sqlite 子进程饿死，
     写入永远完不成（改成 `await` 让出 CPU）；
  2. **更关键**：轮询用的 `sqlite3` CLI 连接**没设 `busy_timeout`**（生产库的 5000ms 是 `db/index.ts`
     给 app 连接设的，CLI 不吃那套），撞上写锁立刻抛 `database is locked` 而不是等。
  现已在轮询里加 `-cmd '.timeout 5000'`，并加注释说明这两个坑。**15 轮连续并发跑全绿后收工**。
  另一处同类毛病（生产代码）：`install.ts` 的 `waitUntilUnloaded` 也用忙等等 launchd，
  已改 `Atomics.wait` 同步睡眠（不烧 CPU）。

- **未做的部分（建议归 #26 的上线检查单）**：
  * **真机重启验证**：`RunAtLoad` 的语义已用「bootout + bootstrap 后不 kickstart 就自动起」等价证明，
    但那不等于「整机重启后自启」——后者需要一次真重启，属人工走查项（本票没重启用户的机器）。
  * **家人设备实测**：iPad / iPhone / Android / 桌面四种设备的真实访问（含「添加到主屏幕」），
    归 #26（本票只用 curl 验了两条通道）。
  * **Time Machine 双通道的端到端验证**：本机 `tmutil destinationinfo` 显示 **没有配置备份目的地**，
    所以只能验证「排除项已登记」（`tmutil isexcluded` 返回 `[Excluded]`），
    无法验证「备份里真的没有 .env」。要在配了 TM 的机器上走查一次。
  * **`NGINX_CONF` / `NGINX_LISTEN` 的默认值绑定本机**：`nginxEntryConfPath()` 默认找
    `servers/apps-proxy.conf`、`NGINX_LISTEN` 默认 8080。换机器要设这两个环境变量
    （已在 `docs/deploy/README.md` 与错误信息里写明）。

## 归属 #26（验收收尾）

- ✅ **已由本票处理**（掌勺者按餐指定，无独立 issue，由调度直接派发，
  分支 `pi-web-agent-27823ed2-c3e5-4eff-a854-69afe0c94a66`，2026-09-20）：
  **需求变更：掌勺者从「家人身上的全局标记」→ 「按餐槽指定」**（用户原话「掌勺者应该是随时可以改的」
  +「掌勺者会跟具体的某一餐绑在一起」）。
  * **存储**：迁移 `011_cook_per_meal` 给 `meal_events` 加 `cook_member_id` + 当时的姓名/头像快照
    （`cook_member_name`/`cook_member_emoji`，跨列 CHECK 三列同生共死）。落在 append-only 事件流上
    （ADR-0007；因 `meal_events` 的 append-only 触发器让 UPDATE/DELETE 都非法，**加列**是唯一合法变更）；
    存快照不回头查 members——家人被软删（010）后历史菜单里也照旧读得出当时的名字（不留 undefined 的洞）。
  * **`is_cook` 的最终处置：保留**（选项 A），不废掉。它收窄为「家里**通常**做菜的那位」，是**最底一层**
    缺省值：开 app 默认身份取它（`identity.tsx`），掌勺者一路往前没有可继承时才回落到它
    （服务端 `defaultCook`）。为此本票同时把它做成可改（`ProfilePatch.isCook` + 家人页勾选）。不废掉的
    理由：`identity.tsx` 的「当前身份缺省 = 掌勺者」依赖它（废掉会让“开 app 默认是谁”失去依据），
    且“家里通常谁做”是真实信息。
  * **掌勺者的缺省层次（调度层口径修正：不指定就按上一餐继承）**：不传 `cook` 时，服务端取
    **本餐槽自己或它之前最近一餐里当前生效的那位掌勺者**（只看每个餐槽的最后一条事件，所以取消/改掉的
    旧值不算），一路往前都没有才回落 `is_cook`。读侧把推导结果单独下发为 `MealSlot.cookDefault`
    （与 `leftoverSource` 同一性质：不是餐槽属性而是一个推导出来的缺省），前端不自己重算“上一餐是谁”。
    继承时会 **JOIN 在用的家人**：上一餐那位若已被软删除就继续往前找（新写的餐里不出现已删家人，
    与 `resolveDiners` 同一口径）。
  * **转正入口按餐判定**：`ReviewView` 的 `PromotionForm` 原先看全局 `current.isCook`；
    现改为看**那一餐的掌勺者**（`meal.cook.memberId === current.id`）。转正是「外部菜上桌后」的动作，
    该由做了这一餐的人决定。**兜底**：那一餐没指定（NULL）时回落到全局 `is_cook`（“没指定就按家里的习惯”）。
    ⚠️ 这里的“没指定”是**写进事件的 NULL**（定餐时显式不指定），与“不传 `cook` 时按上一餐继承”是两回事：
    后者在写入时就已经继承成一个具体的人，不会存成 NULL。
  * **三视图覆盖**：A（大卡 `hero-cook` / 小卡 `ghost-cook-*`）、B（展开行 `compact-cook-*`）、
    C（主屏 `simple-cook`）**都显示**掌勺者；**改的入口是同一个定餐编辑器**（`/slot/:id` 的 `cook-picker`），
    三视图不各造一套选择器（与总纲 §2.10「三视图共享同一操作语义」同口径）。
  * **测试**：`server/src/api/slots.test.ts` 新增 15 条（指定/上一餐继承/餐次排序/继承只看当前有效事件/
    继承跳过已删家人/cookDefault 下发/显式 null/改餐/只改掌勺者不标清单过期/unknown_member/
    软删后历史快照+不能再指定/取消清掉/撤销退回/回顾带出）；`server/src/api/members.test.ts`
    新增 1 条（isCook 可改）；`server/src/db/schema-011.test.ts` 新增 1 条（跨列 CHECK）；
    `e2e/s11-cook.spec.ts` 新增 4 条；`e2e/promote.spec.ts` 新增 2 条（按餐判定 + NULL 回落，判别性）。

- ✅ **已由本票处理**（同票配套的两个「今天页」真 bug）：
  * **页头日期改成服务端下发**（原先 `AppHeader` 用 `new Date()` 浏览器本地时间，与餐槽卡的
    家庭时区「今天」可能差一天）。修法：`AppHeader` 调 `useSlots(3)` 读 `slots.data.today`
    （TanStack Query 与 HomeView 共用一个 `['slots',3]` 缓存，**不多打接口**）；`today` 未到位时不显示日期
    （不用本地时间兜底——那正是要修的 bug）。E2E：`s11-cook.spec.ts` 断言页头文本与服务端 `today` 现算一致。
  * **冷藏期文案「until 起」说反了**（`HomeView.tsx` 的 `hero-cooling`；`until` 是**解禁日**，
    不是起始日）。修为「until 起可以再推」，与 `ReviewView.tsx` 的 `cooling-list` 一致。
    全仓 grep 只有这两处（`grep -rn "until" web/src/`；服务端 `feedback.ts` 是算法不动）。

- ✅ **已由本票处理**（同票第三件真 bug，由调度层追加）：**`release-notice` 把裸槽 id 念给用户听**
  （`HomeView.tsx`：`released.join('、')` 直接渲染 `'2026-09-20:dinner'`）。修法：新增 `slotLabel(slotId, today)`
  （与 `dayLabel` 共用 `dateLabel`，同时说清日期与餐次）；与 `leftoverSourceLabel` 的差别（一个恒“中午”、
  一个要说餐次）在注释里说明。E2E：`e2e/s4-leftover.spec.ts` 的 `release-notice` 断言改为「不出现 `:` 形式的槽 id」
  （原先 `toContainText(dinner)` 正是把裸 id 写进断言——已改准）。
- **营养表还缺 23 个食材（蚝油 46 次、八角 24、香叶 22 …）**（来源：营养与食谱票实施，2026-09-20）。
  本票的营养数据取《中国食物成分表（标准版）》第 6 版（经 nlc.chinanutri.cn/fq/ 平台取数），
  覆盖率 90.9%（按食材项出现次数）；平台查不到对应条目的 23 条**宁可缺失也不编数**，
  读接口与界面会把它们报成「部分食材没有营养数据」。现状的风险不是「数字错」而是「数字偏低」：
  * 最高频的缺口是**蚝油（46 次）**——它糖高、盐高，漏掉它会让用了蚝油的菜热量偏低；
    **若日后要补，最值得补的就是它**（“蚝油” 在商业营养数据里通常有值，只是不在第 6 版表里）。
  * 其余是香料（八角/香叶/桂皮/孜然/十三香/黑胡椒/花椒油/丁香/月桂）、
    姜黄粉/香菜粉（西式）、虫草花/海鲜菇、当归、高汤/柱侯酱/老干妈/香草精、
    糯米粉/黑米/三文鱼/海盐（平台无条目而市面有同类产品营养标签可依）。
  **归属：#26 的上线检查单**：要么补录上述高频项（补录时必须逐行带 `source`），
  要么明确记「接受当前覆盖率的偏低风险」。
  补充说明：本表的数字来自**平均食物成分**（同一食材不同季节/品种/部位差别不小），
  份量是**生重**，**未计烹饪损耗**——这个口径已在界面（`nutrition-note`）与服务端
  （`MenuNutrition.nutritionSource`）两处如实标注，不得在后续票里改成「精确营养」之类措词。

- **B/C 视图没有「营养」与「食谱」入口**（来源：营养与食谱票实施，2026-09-20）。
  用户口径确认过：本票**只做 A（今天页大卡）+ 编辑器（`SlotView`）**，B（`CompactView`）/C（`SimpleView`）
  后续票再补。所以现状是：
  * `web/src/routes/CompactView.tsx` / `web/src/routes/SimpleView.tsx` 里既没有「📊 营养」也没有「食谱」；
  * 服务端与领域层是**视图无关**的（`GET /api/slots/:id/nutrition` 与 `GET /api/recipes/:id/recipe`），
    两个面板（`web/src/components/NutritionSheet.tsx` / `RecipeSheet.tsx`）也是独立组件——
    B/C 补入口时**只需接一下按钮**，不必改服务端。
  **归属：#26 的三视图统一收口**（与上面「B/C 的新入口照 `e2e/views.spec.ts` 的对照用例办理」同口径）：
  B/C 补上入口后，把它加进那个对照用例的清单（同一操作三视图走一遍、服务端逐字段一致），
  而不是各写各的断言。

- ✅ **已由本票处理**（C 视图留量入口；无独立 issue，由调度直接派发，
  分支 `pi-web-agent-0027c7c7-9ac5-4e1f-b892-60b5963dd3b6`，2026-09-20）：
  **C 视图（长辈小孩极简）的「留量」入口已补**（`web/src/routes/SimpleView.tsx`：未定时
  大按钮 `simple-leftover`、已定成「吃剩的」时大字说明 + `simple-cancel-leftover`）。
  与 A 同一语义：状态来自**服务端下发的** `slot.leftoverSource`（前端不自己拼「晚餐 + 同日午餐已定」），
  动作走同一条 `useBookLeftover`，显示条件同 A（`leftoverSource && !decided`）。
  **「回顾」入口经核实不缺口**：三视图共用底部 `TabBar` 的 `/review` tab，C 已经能到回顾页——
  只补了留量，没有另造回顾入口。
- ✅ **已由本票处理**（同票配套）：**三视图语义一致的判别性证据已进 `e2e/views.spec.ts`**。
  新增三条（均进同一个文件的对照清单，不另写零散断言）：
  * 「吃剩的」在 A/B/C 各走自己的实现（A 大卡 `book-leftover-button` / B 编辑器 `leftover-entry` /
    C 主屏 `simple-leftover`）→ 服务端逐字段一致（含 `leftoverOf`、现推导的留量菜、逐菜 `uplift`、
    末条留痕；对照基准是独立打 API 的服务端现算结果，不是「B/C 抄 A」）；
  * C 自己的可见性与取消（吃剩的那一餐看得见、`simple-cancel-leftover` 能退回未定）；
  * C 的阴性对照（午餐没标留量时不给大按钮）。
  既有的「定一餐」对照用例**未动**：留量需要不同前置（同日午餐已定且标了留量），塞进去会把
  「推荐 → 接受」的主题搅浑——故另起一条对照用例，三视图各走各的入口并逐字段与服务端对照。
- **B/C 的 E2E 只覆盖到「看得到 + 走得通」**（来源：#24 实施）。三视图语义一致的判别性证据
  在 `e2e/views.spec.ts` 的对照用例（同一操作在 A/B/C 走一遍、服务端逐字段一致）；
  后续 #20/#22 给 B/C 补新入口时，应把它加进那个对照用例的清单，而不是各写各的断言。
  （**留量那一条已按此执行**，见上；若之后 B/C 再有新入口，照此办理。）

- **无 key 时真调用冒烟会静默 skip**（来源：#17 审查）。`server/src/llm/openai.smoke.test.ts` 用 `describe.skipIf`，本机有 key 时确实跑通（2 条真实执行过），但在别人机器/CI 上会**静默不跑**——「真调用」这条 AC 可能变空头支票。**#26 的上线检查单应包含「在有 key 的环境跑一次 `pnpm test` 并确认 smoke 未被 skip」。**
- **真部署（DashScope 百炼）需人工走查 strict `json_schema` 档**（来源：#17 审查）。本机代理端点不支持 strict，实现按「失败即转 `json_object`」处理并有测试覆盖；但生产端点支持时该档能否真的生效，只能在真端点验一次。
- **学龄前宝塔 OCR 值的人工复核**（来源：#16 审查）。§5-1 原文要求「OCR 值，**入库前复核一次**」。现状：数值在 DB `source` 列、API 响应、迁移文档三处如实标注「未对照原图复核」，但**无复核人/日期记录**。findings 也有同名 open question。
  - **#26 的上线检查单应包含这一条**（或明确记为「接受 OCR 风险」）。
- **成人能量锚点（2250/1800 kcal）的来源缺口**：来自 DRIs 纸书（未开放），findings open question 3 已记录。同样应进上线检查单。

## 归属：外部池观察轮（2026-09-20 grilling 会话定案，无票号）

来源：交割文件 `handoff-external-pool-2026-09-20.md` 提出的「外部池怎么才算用起来」。会话中两个**事实修正**推翻了交割文件的定性，全部决策与查询集详见 [`docs/research/2026-09-20-external-pool-observation.md`](../research/2026-09-20-external-pool-observation.md)：

- **「口述冲刺的化石」不存在**：`oral` 18 道全部已转正（即家庭池 8+7+3）；`draft` 257 道全部是导入的（howtocook 254 + llm 1 + scraped 2）。「批量转正」不存在「其实做过」的开脱。
- **「外部菜一道都推不到」只对前两餐成立**：去重先于取池（`buildPool`），荤位家庭 8 道 × 每餐 4 道 → 第 3 餐起 `kept=0` 补 3 道外部且荤位缩水成 3 道。机制即将大量触发，不是永不触发。

### 观察任务（期末 2026-09-27，勿丢）

- **验收 = 转正闭环**：至少一道外部菜走完「上桌 → 餐后回顾确认 → 转正进家庭池」（转正链路 #21 已交付）。
- **升级条件（任一触发重开门槛讨论，方向一 = 调 `MIN_FAMILY_PER_POSITION` / 固定配额）**：外部菜上桌 < 2 道，或上桌 ≥ 2 道 but 转正 0 道（此时先查转正入口可见性再谈门槛）。
- 查询集与基线快照在观察文档 §3–§5，期末照抄执行、结果回填 §6。
- 若走到调门槛：落点是 `family_rules` 单例表（#26 家规收口，代码 TODO 已标），顺手一起做。

### 下轮工单 1：加菜器搜索 + 筛选（方案已定）

- `SlotView.tsx` 加菜器在 257 道草稿下 164 按钮平铺不可用。改造：菜名搜索 + **菜系 / 难度 / 按主料（食材，join `recipe_ingredients`）** 筛选 + 做过/没做过筛选。
- **「没做过」判定 = `status=draft`**（与现有小标、CONTEXT.md「origin（草稿=external）」、台账 #21 三处同口径；不引 `source` 第二套判定——同页双口径是坑）。

**✅ 已实施（issue #27，2026-09-20）**，落地在 `web/src/components/DishPicker.tsx`（纯前端过滤，零 API 变更）+ `e2e/picker.spec.ts`。实施中新增的两条判断，记在这里免得后续票重复纠结：

- **菜系多出「未标」一档**（`cuisine === null`，导入期 LLM 初打没跑成的那些）。方案里只列了 11 个菜系，但 `cuisine` 可为 null（迁移 005 允许）——没有这一档，那些菜一旦动了菜系筛选就永远不可达。**判断：筛选器不该有看不见的洞**，加了。
- **菜系选项表现在有 web 层两份**（`DishPicker.tsx` 与 `ReviewView.tsx` 各一份 `CUISINE_OPTIONS`）。本票只是新增第二份，台账「归属 #21」那条（转正表单的菜系选项表是手抄的）的**收口面因此翻倍**——#26 若要收口，两处一起改。

**⚠️ 本票未做、留给后续的**（来源：#27 的 Spec 轴审查）：

- **「没做过」小标只落在编辑器一处**（issue #27 story 20：「草稿菜被选中后仍带小标**进菜单**」）。`web/src/routes/SlotView.tsx` 的「这一餐的菜」行现在带了，但**已定菜单的其它渲染点都没有**：`HomeView.tsx` 的 hero 菜行（`hero-dish-*`）、`CompactView` 的行内展开、`SimpleView` 的吃这些卡。根因是 `MenuDish`（`wire-types.ts`）不携带菜谱状态，前端要判只能另查 `useRecipes('all')`——那是**跨三套视图 + 改共享类型**的改动，超出本票「加菜器搜索与筛选」的范围。**判断：story 20 的「现状保持」其实不成立**（基线本来就没有这枚标），本票只把新加的这一处做对；要做全得另起一票。
- **主料搜索不匹配食材别名**：只比 `ingredients[].name` 的规范名（与 issue #27 的 Implementation Decisions「食材名包含匹配」一致）。搜「西红柿」找不到「番茄」——那要另拉一份字典，归**下轮工单 2（字典补录）**。
- **主料匹配含调料**：搜「盐」会大面积命中（`ingredients` 是完整清单）。issue 的决策行写的就是「食材清单」，故合规；但 story 标题说的是「主料」——两处措辞有偏，未改。
- **`hiddenChosen` 只数非退役的已选菜**：已定菜单带进来的退役菜不计入「被筛掉了 N 道」的提示（退役菜本来就不上加菜器，这条规则先于筛选）。同一渲染点（SlotView 已选行）能看到它们，所以没有静默丢失。

### 下轮工单 2：字典补录「扁平 + 三件套」（方案已定，接 #19 旧条目）

✅ **已由 #28 处理**（2026-09-20）。落地面：迁移 `013_ingredient_base_entries.sql`、
`domain/library.ts` 的清洗/归一（`isNoiseIngredientName` / `splitCombinedIngredientName` / `stripQuantityTail`）、
测试 `domain/library.test.ts`（归一清洗）+ `db/schema-013.test.ts`（迁移纪律）+ 推荐/换菜/清单三处忌口与分列。

- ✅ **新增裸名基础条目**（猪肉/鸡肉/芝麻/米饭/蒜粉/姜粉/椒盐粉/白葡萄酒/芥末/小苏打）。
  **「带时令月份」这条按显式判断落成「四季常售、不录月份」**：现有 40 条时令全是蔬菜/菌菇，
  新增的 10 条都是肉/禽/主粮/调料，按 002/005 的口径不录 = 四季有售（给四季常售的东西填月份
  等于把时令信号抹成常量，见 `seasonIngredientCount` 的 30–40 硬边界）。羊排走 `lamb` 的别名
  而不是新建带月份的部位条目（试过，会把时令表顶到 41 种）。
- ✅ **`ingredient_contains` 指针连部位**（猪排骨→猪肉、白芝麻→芝麻、干辣椒→辣椒…共 42 条）：
  忌口沿既有展开机制向上传播，推荐/换菜两处零改动自动生效。**方向单向**（`pork` 不指回细类）。
- ✅ **子类（品种：黑猪/野猪）不入库**：字典表没有 parent_id，菜谱 A「猪肉」+ B「猪梅花肉」
  在买菜清单上**分列不合**（`api/grocery.test.ts` 有一条钉住两行两克数）。
- ✅ **44 条杂讯在导入管线过滤**（不进字典）：分两类——**整项丢**（分段小标题/厨具/说明片段，
  共 28 条进报告的 `dropped` 清单）与**剥尾巴留食材**（「盐量 = 份数」→ 盐、「牛肉用量为」→ 牛肉，
  后者不能丢，丢了就是买菜缺项）。「姜蒜」类连写名拆成两条、克数按段数均分。
- ✅ **重刷已实测**（对生产库的副本跑 `--replace --llm`）：归一失败 **254 → 136 个名字**（305 → 142 次出现），
  草稿 254 道、0 克项清零（重标 2178/2178 = 100%），家庭菜谱 18 行与逐食材克数**逐行一致**（一字未动）。
- ✅ **错别字别名**（story 7）：耗油→蚝油、柱候酱→柱侯酱、西蓝花→西兰花；同批补了口语写法
  （肉→猪肉、温水/冷水/沸水→水、南乳→腐乳…）。**长尾真缺项不补**（印度综合香料粉/白芷/酥油
  仍在 `unmatched` 里，是刻意留着的欠账）。
- ✅ **否决了 parent_id 真层级**（部位/品种两维之分、忌口语义分叉、267 项重分层无权威来源）——
  日后若真要按品种追踪再议，届时立 ADR。

**本票未做、留给后续的**（来源：#28 实施）：

- **「A 或 B」的名字（`土豆或南瓜`、`酸奶或牛奶`、`剑骨鱼或鲤鱼`）仍在 `unmatched` 里**。
  实施中曾加过一条「选项指向同一食材才归一」的专用机制，**又删掉了**：它在真实数据上零收益
  （`料酒或者黄酒` 靠既有的包含匹配就归得上），反而多一条要维护的规则。真二选一的两个候选
  长度并列时包含匹配自然判失败——**这就是想要的行为**（替家里选一个就是把菜买错）。
- **「只有调料、没有主料」的草稿有 18 道**（`汤面` 只剩水 400g、`紫菜蛋花汤` 只剩盐 2g）。
  它们不是本票引入的：数据源原文就只给了那些（`汤面` 的「面类材料」/「菜类」是分类词，
  不是食材名；`紫菜蛋花汤` 的原文只有「盐 2 克」）。**这 18 道进不了推荐池的理由与 0 克项不同**
  （`hasPendingRelabel` 只管 0 克），目前靠 `kind` 与食材清单自然挡——若日后发现它们真上了桌，
  那是一个独立的小票（要处理的是「分类词当食材名」的解析）。

## 判断性但**刻意不改**（记录理由，避免后续票重复纠结）

- **时令是「排序」不是「过滤」**（来源：#17 审查）。spec §4① 用词是「按荤/素/汤位 × 时令月份检索」，ADR-0001 也写「时令筛选」；实现是**排序**（`server/src/llm/prompt.ts` 的 `rankPool`、`server/src/domain/ingredients.ts`）。
  - **判断：偏离字面但正当**。依据是 #15 迁移自己的口径：「一个食材一行都没有 = 未录 / 四季有售」——若把「未录时令」当「不时令」过滤，整个四季皆宜的库会被排掉，与「时令是软启发而非硬约束」的产品意图相反；且 spec §5 的时令表本就是「手工维护 30–40 种常买食材」的不完整表。
  - 已写进代码注释；**若日后要做真过滤，必须先补全时令表并重新评估**。
- **降级原因在界面上只显示最后一条**（来源：#17 审查）。`web/src/routes/HomeView.tsx` 取 `notes[notes.length - 1]`，前几次失败原因丢弃。§4 只要求「显著标记」，列表会给手机屏增加噪音。**保留**。
- **`SEASONINGS` 把辣椒/豆瓣酱/蒜/葱/姜当调料剔出主料**（来源：#17 审查）。会让「宫保鸡丁」的 `mains` 只剩鸡腿肉。主料**仅用于展示**，不影响结构/过滤/份量，取「宁可少列」。已在 `server/src/domain/recommendation.ts` 的白名单上方注明边界。**保留**。

- **`PortionInput` 与 `SlotBooking` 形状重复**（来源：#16 审查）。两者同形状（`PortionInput` 少一个 `source?`），`portion.ts` 处还强转一次。判断：都在 `server` 包内、由类型检查兜住，提取共享类型收益小、改动面大于收益。**若后续票要动这两个形状，一并合并。**
- **`portionError` 与 `bookingError` 的映射重复**（来源：#16 审查）。五项相同，作者注释已承认是有意的（错误体字段随路由而变：`recipeId` / `memberId` / `id`）。**保留。**
- **`uplift` 占位**（来源：#16 审查，判定「轻度 Speculative Generality，可接受」）。理由：留一个位置让 #22 只改一处。**保留至 #22。**
  ✅ 已由 #22 兑现：`uplift` 现在报**实际生效**的系数（标记 ∧ 引用），不再是恒 1 的占位；
  家规配置值经 `/api/portion/rules` 的 `rules.uplift` 读出，每份菜单的读数看 `portion.uplift`。
- **重复删家人报 404 而不是幂等 200**（来源：家人管理票审查）。`deleteMember` 对已删的家人抛
  `MemberNotFoundError` → 404。评审判为「可接受取舍」并征询实施者意见，**定为保留**：
  与读口（`GET /members/:id` 对已删家人也是 404）及仓库其余删除（取消未定的餐槽 404 `not_decided`、
  撤回已撤回的反馈 404 `feedback_not_found`）同一口径；重复删的真实形态是「另一台设备拿着过期列表」，
  这时「这位家人不在了」恰好是要告诉用户的事。理由已写在 `server/src/domain/members.ts` 的
  `deleteMember` 注释里。**若日后要做幂等删除，三处应一起改，不要只改这一处。**

---

## 环境记录：pi-web 需要重启才能加载新的模型能力配置

**症状**：附图时 harness 提示「model does not support images」，图片被静默丢弃（会话 jsonl 里那条 user 消息只剩文本，`content` 数组无 image 项）。

**根因（已核实）**：`pi-web` 进程（PID 20683）启动于 **9-12 20:57**，已连续运行约 7 天；它在启动时读取 `~/.pi/agent/models.json` 并把模型能力缓存进内存。该文件在 **9-19 20:06** 才被改成 `input: ["text","image"]`（此前是 `["text"]`，见备份 `models.json.bak-codebuddy2`）。**运行中的进程仍用旧能力**，故内核按「不支持图片」处理并丢弃附件。

**能力实测（与提示相反，实测为准）**：
- 配置声明：`codebuddy2/deepseek-v4.1-flash` 的 `input = ["text","image"]`
- 端点实测：向 `127.0.0.1:8004` 发 64×64 纯红 PNG（`image_url` + data URI）→ HTTP 200，模型答「红色」→ **确实支持图片**
- 注意：第一次用 1×1 像素图测试被拒（`invalid_image_data`），那是**退化图**问题，与能力无关

**修复**：重启 pi-web 进程即可（新进程读新配置）。会话本身存在 jsonl 里，不会因重启丢失。

**教训**：harness 的「model does not support images」提示来自**运行中进程的内存状态**，可能是过期配置——**别直接采信，用 `ps` 查进程启动时间 vs `models.json` 修改时间来交叉验证**。
