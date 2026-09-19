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
| 9 | #21 M1-09 转正流程 | — | — | 待做 |
| 10 | #22 M1-10 留量 | — | — | 待做 |
| 11 | #23 M1-11 买菜清单 | — | — | 待做 |
| 12 | #24 M1-12 三视图与视图模式 | — | — | 待做 |
| 13 | #25 M1-13 部署与备份 | — | — | 待做 |
| 14 | #26 M1-14 验收收尾 | — | — | 待做 |
| — | **#12 父 spec 收尾** | — | — | 全部子票关闭后处理 |

**建议执行顺序**（依赖关系）：#20 → #21；#19 可与 #20 并行；#22（依赖 M1-04 已完成）→ #23；#24（依赖 #18 已实现，待审查）→ #23；#25（只依赖 #13，可随时做）；#26 最后。

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

- **`dad-loves-entry-${id}` 丢 kind 的设计脆弱点**（来源：#14、#15 审查）。`member_loves` 表允许菜粒度与食材粒度共存（`{kind, id}`），但前端 `data-testid` 只用 id——若某菜谱 id 与食材 id 相同会 strict 冲突。**实测当前 20 个菜谱 id 与 70 个食材 id 零交集**，无实际风险；但 #21 转正会新增菜谱 id，届时应把 testid 带上 kind。

## 归属 #22（留量）

- **留量上浮的家规化**：`LEFTOVER_UPLIFT`（`server/src/domain/portion.ts`）现为常量恒 1，上浮真实系数（默认 1.5×）与家规配置由本票接。
- **UI 不得显示未兑现的倍数**（来源：#15 审查、#16 已修一半）。`HomeView` 曾硬编码「留量 ×1.5」而引擎 `uplift=1`——已改为只标「留量」。**#22 上浮真正生效后，才可以把倍数显示回来（且应从 `portion.uplift` 动态读，不要再硬编码）。**

## 归属 #23（买菜清单）

- **S1 的 E2E 跨票缺口**（来源：#17 审查）。§1.2 S1 的通过标准含「买菜清单页出现本餐聚合的食材与生重」；#17 的 E2E 只覆盖了 S1 的推荐段。**#23 需把 S1 的 E2E 补完整（推荐 → 接受 → 清单出现聚合），或在 #26 统一收口。**

- **WS/T 554 表 3/4「每餐克数」未录**（来源：#16 审查，判定「可后补」）。现状：003 录了表 1（能量）+ 附录 A（互换）+ 宝塔推荐量篮（全天量）+ 餐次占比。表 3/4 是「每餐各类食物克数」，与已录推荐量篮 × 餐次占比在功能上重叠，且**本票的买菜清单按「菜谱食材生重聚合」**（§2.7），不依赖表 3/4。
  - **建议**：不必单独录表 3/4（重叠数据易漂移）；若 #23 实现中确实需要「每餐建议量」做校验/提示，再按需录。**派发 #23 时确认这个判断。**

## 归属 #26（验收收尾）

- **无 key 时真调用冒烟会静默 skip**（来源：#17 审查）。`server/src/llm/openai.smoke.test.ts` 用 `describe.skipIf`，本机有 key 时确实跑通（2 条真实执行过），但在别人机器/CI 上会**静默不跑**——「真调用」这条 AC 可能变空头支票。**#26 的上线检查单应包含「在有 key 的环境跑一次 `pnpm test` 并确认 smoke 未被 skip」。**
- **真部署（DashScope 百炼）需人工走查 strict `json_schema` 档**（来源：#17 审查）。本机代理端点不支持 strict，实现按「失败即转 `json_object`」处理并有测试覆盖；但生产端点支持时该档能否真的生效，只能在真端点验一次。
- **学龄前宝塔 OCR 值的人工复核**（来源：#16 审查）。§5-1 原文要求「OCR 值，**入库前复核一次**」。现状：数值在 DB `source` 列、API 响应、迁移文档三处如实标注「未对照原图复核」，但**无复核人/日期记录**。findings 也有同名 open question。
  - **#26 的上线检查单应包含这一条**（或明确记为「接受 OCR 风险」）。
- **成人能量锚点（2250/1800 kcal）的来源缺口**：来自 DRIs 纸书（未开放），findings open question 3 已记录。同样应进上线检查单。

## 判断性但**刻意不改**（记录理由，避免后续票重复纠结）

- **时令是「排序」不是「过滤」**（来源：#17 审查）。spec §4① 用词是「按荤/素/汤位 × 时令月份检索」，ADR-0001 也写「时令筛选」；实现是**排序**（`server/src/llm/prompt.ts` 的 `rankPool`、`server/src/domain/ingredients.ts`）。
  - **判断：偏离字面但正当**。依据是 #15 迁移自己的口径：「一个食材一行都没有 = 未录 / 四季有售」——若把「未录时令」当「不时令」过滤，整个四季皆宜的库会被排掉，与「时令是软启发而非硬约束」的产品意图相反；且 spec §5 的时令表本就是「手工维护 30–40 种常买食材」的不完整表。
  - 已写进代码注释；**若日后要做真过滤，必须先补全时令表并重新评估**。
- **降级原因在界面上只显示最后一条**（来源：#17 审查）。`web/src/routes/HomeView.tsx` 取 `notes[notes.length - 1]`，前几次失败原因丢弃。§4 只要求「显著标记」，列表会给手机屏增加噪音。**保留**。
- **`SEASONINGS` 把辣椒/豆瓣酱/蒜/葱/姜当调料剔出主料**（来源：#17 审查）。会让「宫保鸡丁」的 `mains` 只剩鸡腿肉。主料**仅用于展示**，不影响结构/过滤/份量，取「宁可少列」。已在 `server/src/domain/recommendation.ts` 的白名单上方注明边界。**保留**。

- **`PortionInput` 与 `SlotBooking` 形状重复**（来源：#16 审查）。两者同形状（`PortionInput` 少一个 `source?`），`portion.ts` 处还强转一次。判断：都在 `server` 包内、由类型检查兜住，提取共享类型收益小、改动面大于收益。**若后续票要动这两个形状，一并合并。**
- **`portionError` 与 `bookingError` 的映射重复**（来源：#16 审查）。五项相同，作者注释已承认是有意的（错误体字段随路由而变：`recipeId` / `memberId` / `id`）。**保留。**
- **`uplift` 占位**（来源：#16 审查，判定「轻度 Speculative Generality，可接受」）。理由：留一个位置让 #22 只改一处。**保留至 #22。**

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
