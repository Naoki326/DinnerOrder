# 菜谱（菜单/菜品模板）库是怎么管理的？新菜怎么加？为什么现在很少？

调研日期：2026-09-20 ｜ 只读调研（read / grep / sqlite3 SELECT / git log），未写任何库、未跑任何 pnpm 命令。

---

## 一句话结论

菜谱库是**两层结构**（`recipes.status='draft'` 的外部素材层 + `'active'` 的家庭库），代码里**唯一的写入口只有两个**：离线 CLI `import-library.ts`（批量落草稿）与 `POST /recipes/:id/promotion`（草稿转正）；**没有任何「新增一道菜」的 HTTP 接口、也没有任何「编辑已转正菜谱」的接口**。库里现在只有 **30 道**（18 active / 11 draft / 1 retired），因为外部池的批量导入（spec 要求的 150–300 道）**从来没有对真库跑过**：`server/library-data/howtocook.jsonl` 里 266 道候选与库里现有 30 道 **id 交集为 0**，`data/import-report.json`（导入的产物）也不存在。所以「少」不是设计如此，而是「导入这一步没执行」。

---

## 一、数据模型（实际 schema，非文档）

以下为 `sqlite3 -readonly data/dinner.dev.db ".schema ..."` 的真实输出（`data/dinner.db` 同构）。

### `recipes`（迁移 002，`cuisine` 列由 005 追加）

```sql
CREATE TABLE recipes (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,                                  -- 菜名全库唯一，家人叫法进 recipe_aliases
  kind   TEXT NOT NULL CHECK (kind IN ('meat', 'veg', 'soup_meat', 'soup_veg')),
  effort TEXT NOT NULL CHECK (effort IN ('quick', 'medium', 'heavy')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  source TEXT NOT NULL CHECK (source IN ('oral', 'howtocook', 'scraped', 'llm')),
  steps  TEXT NOT NULL DEFAULT '',
  cuisine TEXT CHECK (cuisine IS NULL OR cuisine IN
    ('川','粤','鲁','苏浙','湘','东北','闽','徽','西北','京','家常'))
);
CREATE INDEX idx_recipes_status ON recipes (status);
```
（来源：`server/migrations/002_recipes_and_meal_slots.sql:27-41`；`cuisine` 追加见 `server/migrations/005_import_toolchain.sql:39-43`）

**状态机三个值的语义**（`status`）：
- `draft` = 外部菜谱池的**存储形态**（不是另一张表）：来源是 HowToCook / 下厨房 / LLM 的素材，不进推荐池常态，只在家庭池某位不足时补位。（来源：`server/migrations/004_external_recipe_pool.sql:4-6`；`server/src/domain/library.ts:18-19`）
- `active` = **家庭菜谱库**，推荐池与换菜候选的**唯一来源**（`listRecipes(db)` 缺省只列它）。（来源：`server/src/domain/recipes.ts:42-51`；`docs/adr/0006-...md:3`）
- `retired` = 退役：不进推荐、行保留（历史要能查）；退役菜不能进菜单（`RecipeRetiredError`），要吃先转正。（来源：`server/src/domain/promotion.ts:30-31`；`server/src/domain/slots.ts:761-766, 855-858`；`web/src/routes/SlotView.tsx:858-864`）

**`source` 四个取值**：`oral`（口述）/ `howtocook` / `scraped`（下厨房）/ `llm`。**如实记录，转正不改写**（转正改的是做法，不是出身）。（来源：`server/migrations/002_recipes_and_meal_slots.sql:38-39`；`server/src/domain/promotion.ts:37-40`；`server/src/wire-types.ts:168`）

### 与菜谱相关的其它表

| 表 | 关键列 | 出处 |
| --- | --- | --- |
| `recipe_aliases` | `recipe_id` + `alias TEXT PRIMARY KEY`（**别名全局唯一**，插入用 `INSERT OR IGNORE`） | `.schema`；`server/src/domain/library.ts:466-468` |
| `recipe_ingredients` | `(recipe_id, ingredient_id)` 主键，`position` UNIQUE，`adult_grams REAL NOT NULL CHECK (adult_grams >= 0)`（**0 = 模糊份量待 LLM 重标**，迁移 005 把原来的 `> 0` 放宽），`scaling`、`raw_cooked_anchor`、`source_quantity`（采集原文，只作重标证据） | `.schema`；`server/migrations/005_import_toolchain.sql:526-561` |
| `recipe_tastes` | 封闭五标签 `CHECK (taste IN ('甜','辣','酸','咸鲜','清淡'))`，多选 | `.schema`；`server/migrations/002...sql:54-58` |
| `recipe_season_months` | `month BETWEEN 1 AND 12`，多选；空 = 四季皆宜 | `.schema` |
| `recipe_promotions` | 转正台账：`promoted_at` / `member_id`（家人删了置 NULL）/ `differences`（口述差异，空串≠NULL）/ `cuisine_from`/`cuisine_to` / LLM 元数据三件套（`llm_model`/`llm_prompt_version`/`llm_latency_ms`，**要么全有要么全无**）；**没有 degraded 位**（LLM 失败就没有这次转正） | `.schema`；`server/migrations/008_recipe_promotions.sql` |
| **`recipe_flavors`** | **不存在**。口味表叫 `recipe_tastes`（你问的名字是文档里没出现的名字，全仓库 grep `recipe_flavors` 无命中） | `grep -rn recipe_flavors server/ docs/` → 无结果 |

`data/dinner.dev.db` 的完整表清单（`SELECT name FROM sqlite_master WHERE type='table'`）里与菜谱相关的只有：`recipes`、`recipe_aliases`、`recipe_ingredients`、`recipe_tastes`、`recipe_season_months`、`recipe_promotions`。

---

## 二、数量现状表

查询：`sqlite3 "file:data/dinner.dev.db?mode=ro&immutable=1" ...`（`data/dinner.db` 结果**完全一致**）。

| 维度 | dinner.dev.db | dinner.db |
| --- | --- | --- |
| 总数 | **30** | **30** |
| active（家庭库） | **18**（meat 8 / veg 7 / soup_meat 2 / soup_veg 1） | 18（同上） |
| draft（外部池） | **11**（meat 5 / veg 4 / soup_meat 1 / soup_veg 1） | 11（同上） |
| retired | **1**（meat） | 1（同上） |
| `source` 分布 | oral 18（全 active）、howtocook 9、scraped 3（2 draft + 1 retired）、llm 1 | 同 |
| `adult_grams <= 0`（「待重标」项） | **1 项**，属于 `pending_relabel_ribs`（土豆炖排骨（待重标样本），draft） | 1 项，同一道 |
| draft 里 `cuisine IS NULL` | **3 道**（`xiangguhuaji`、`dongguawanizitang`、`pending_relabel_ribs`） | 3 道 |
| `recipe_promotions` 行数 | **0**（从来没发生过一次转正） | 0 |
| `server/library-data/howtocook.jsonl` | **266 行**（每行一道 `DraftRecipe`；kind 分布 meat 162 / veg 78 / soup_veg 14 / soup_meat 12） | 同 |

**哪个库是活的**（补充验证，2026-09-20 由主会话查证）：`data/dinner.db`。两个 launchd 实例都指向它——`~/Library/LaunchAgents/com.naoki.dinnerorder.plist` 的 `EnvironmentVariables.DB_PATH = data/dinner.db`（8787 直连）与 `com.naoki.dinnerorder.subpath.plist`（8786 供 nginx，共用同一个库）；`ps eww 3935` 实测 `DB_PATH=data/dinner.db PORT=8787 BASE_PATH=/`。`data/dinner.dev.db` 是开发库（`server/src/dev.ts` 的缺省），家人 4 人、`meal_events` 0 条；生产库家人 6 人、`meal_events` 5 条。**两个库的菜谱表完全一致（都 30 道、id 相同）**——因为两者都只是跑迁移跑出来的。（来源：`~/Library/LaunchAgents/com.naoki.dinnerorder.plist`；`ps eww` 输出；`sqlite3 data/dinner.db "select count(*) from members"` → 6 vs `data/dinner.dev.db` → 4）

**关键交叉验证**：jsonl 里 266 个 id 与库里现有 id 的**交集 = 0**（python 只读比对）。也就是说这 266 道候选**一道都没进过库**。旁证：导入的产物 `data/import-report.json` **不存在**（`ls data/ | grep report` 无输出），而该文件由 `import-library.ts` 每次运行必写（`server/scripts/import-library.ts:241-242`）。

**第二个交叉验证（算术守恒）**：30 = 002 的 20 道（18 active + 1 retired + 1 draft，`server/migrations/002_recipes_and_meal_slots.sql:260-280`）+ 004 的 9 道（`server/migrations/004_external_recipe_pool.sql:15-23`）+ 008 的 1 道（`server/migrations/008_recipe_promotions.sql:79-81`）= 20+9+1 = **30**。库里每一道菜都能追溯到一条迁移种子行——没有任何一道来自导入管线或转正。

（来源：上述 SQL；`wc -l server/library-data/howtocook.jsonl`；`server/scripts/import-library.ts:241-242`）

---

## 三、「新菜从哪进来」的 4 条路径

### 路径 1：迁移里的种子（已发生，但只发生在 002/004/008 三次）

- **入口**：`INSERT INTO recipes ...` 写在迁移 SQL 里；仓库里只有 3 处：`002`（18 道 oral active + 1 道 retired + 1 道 draft）、`004`（9 道外部池样张）、`008`（1 道待重标样张）。
- **命令**：无 —— 随 `runMigrations` 自动执行，且 `schema_migrations` 记录后不再重跑。
- **门槛**：无门槛（写死的数据）。
- **证据**：`server/migrations/002_recipes_and_meal_slots.sql:260-280`；`server/migrations/004_external_recipe_pool.sql:15-23`；`server/migrations/008_recipe_promotions.sql:79-81`；`grep -c "INSERT INTO recipes" server/migrations/*.sql` → 002:1、004:1、008:1。
- **这是「现在这 30 道」的全部来源**：18 道 oral active 全部来自 002 的种子（`source='oral'` 在 `server/src` 与 `web/src` 里除了类型定义 `server/src/wire-types.ts:168` 没有任何写入点）。

### 路径 2：离线导入 CLI（**批量落草稿的唯一入口**，尚未对真库跑过）

- **入口**：`server/scripts/import-library.ts`（CLI），落库函数 `importDrafts`（`server/src/domain/library.ts:389-523`）。
- **命令**：
  ```bash
  pnpm --filter @dinnerorder/server run import:library \
    --from server/library-data/howtocook.jsonl --llm
  ```
- **`--from/--snapshot/--replace/--llm/--dry-run` 语义**（逐条给出处）：
  - `--collect-htc <dir> --snapshot <file>`：**只采集不落库**，把 HowToCook markdown 目录采成 JSONL 快照（按 id 去重），写进仓库以便复现。（`server/scripts/import-library.ts:9-13, 95-131`）
  - `--from <快照 JSONL>`：导入的**唯一输入**（每行一道 `DraftRecipe`）。（`:136-141`）
  - `--xcf-dir <目录>`：可选的下厨房那条腿，**必须有 `manifest.json`**，真 URL 从 manifest 取（不从文件名序号猜）。（`:143-176, 300-330`）
  - `--llm`：开 LLM 份量重标（把 0 克改成正数）+ 菜系初打；**不开就全留 0 克待重标**。（`:215-236`）
  - `--dry-run`：报告照出、库一个字节不写（事务回滚；覆盖率在事务内读，避免「读到导入前的小库」）。（`server/src/domain/library.ts:360-368, 494-500`）
  - `--replace`：把**同名/同 id 的草稿**删掉重写；用途是补了字典别名或改了筛选口径后刷新草稿。**家庭菜谱永不覆盖**。（`server/scripts/import-library.ts:221-224`；`server/src/domain/library.ts:447-449`、`:432-444`）
- **幂等吗？** 是。缺省 `onConflict='skip'`：同 id 的草稿已存在 → 该条进 `rejected` 并跳过，不会越导越多。（`server/src/domain/library.ts:374-375, 450-457`；`server/library-data/README.md:69`）
- **`--replace` 会不会覆盖家庭菜谱？** **不会**。`existing.status !== 'draft'` 直接 `rejected`（reason：`导入只写草稿，不覆盖家庭菜谱`）；同名但被家庭菜谱占用的也 `rejected`（reason：`菜名「X」已被家庭菜谱占用，不能覆盖`）。（`server/src/domain/library.ts:408-420, 432-444`）
- **CLI 参数的 `--` 坑**：参数必须**直接跟在脚本名后**，不能插 `--`。本仓库 pnpm 12.4.2 会把 `--` 原样转发给脚本，而 CLI 是 `allowPositionals:false`，于是报 `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`。（`README.md:62-63`；`server/scripts/import-library.ts:70`；`docs/agents/open-items.md:55`）
- **相对路径**一律按**仓库根**解析（不是 cwd），所以要在仓库根执行。（`server/scripts/import-library.ts:73-77, 278-282`）

### 路径 3：转正 `POST /recipes/:id/promotion`（草稿 → 家庭菜，**唯一对菜谱的写接口**）

- **入口**：`server/src/api/recipes.ts:89`；前端入口在餐后回顾页 `web/src/routes/ReviewView.tsx:214-222`（`data-testid="promote-open-<id>"`）。
- **门槛**（4 个错误类，各自触发条件 + 代码行）：

| 门槛 | 错误类 | 触发条件 | 代码行 | HTTP |
| --- | --- | --- | --- | --- |
| ① 菜存在 | `RecipeNotFoundError` | `findRecipe` 查不到 | `server/src/domain/promotion.ts:140` | 404 `not_found` |
| ② **只转草稿** | `RecipeNotDraftError` | `recipe.status !== 'draft'`（active 已转过 / retired 是「不想再做」） | `server/src/domain/promotion.ts:141` | 409 `not_draft` |
| ③ **必须已上桌**（ADR-0006 的核心门槛） | `RecipeNotServedError` | `servedMealOf` 返回 undefined：某餐槽**最后一条非取消事件**的菜单里有这道菜、**且那一餐已过截止时刻**（`hasMealPassed`，家规午 14 / 晚 21） | `server/src/domain/promotion.ts:143-144`；判定 `servedMealOf` 同文件 `:100-123`；`hasMealPassed` 在 `server/src/domain/slots.ts:82-89` | 400 `recipe_not_served` |
| ④ 身份有效（可选入参） | `MemberNotFoundError` | 传了 `memberId` 但家人列表里没有 | `server/src/domain/promotion.ts:147-148` | 400 `unknown_member` |
| ⑤ **LLM 改写必须成功** | `PromotionRewriteFailedError` | `rewriteRecipe` 没给出合法改写（含：待重标 0 克项没被重标成正数） | `server/src/domain/promotion.ts:154-155`；校验在 `server/src/llm/promotion-schema.ts:225-248` | 502 `rewrite_failed` |

  入参另有长度门槛：`differences` ≤ `MAX_DIFFERENCES_LENGTH = 500`（`server/src/domain/promotion.ts:51`；Zod 在 `server/src/api/recipes.ts:42`，超长 400 而不是截断）。
  前端可见性：只有**这一餐的掌勺者**（`meal.cook.memberId === 当前身份`，NULL 时回落全局 `isCook`）才看得见转正入口。（`web/src/routes/ReviewView.tsx:157-163, 273-276`）
- **效果**：就地改写同一行（不新建行），`status` 翻 `active`、`kind/effort/cuisine/steps` 用改写值、食材整体替换（0 克项被丢掉）、写一条 `recipe_promotions` 台账。（`server/src/domain/promotion.ts:158-222`）

### 路径 4：直接改库 / 手工 SQL（**没有产品入口**，只剩这条路）

- 除迁移种子与上面两条外，**没有任何** `INSERT INTO recipes` / `UPDATE recipes` 的非测试调用点。
- `grep -rn "INSERT INTO recipes|UPDATE recipes" server/src server/scripts --include=*.ts`（排除 `*.test.ts`）只剩三处：
  - `server/src/domain/library.ts:462`（导入落草稿）
  - `server/src/domain/promotion.ts:162`（转正改状态）
  - `server/src/domain/library.ts:742`（`UPDATE recipes SET cuisine = ? WHERE id = ? AND status='draft'` —— 只对草稿打菜系 tag）
  - 关联表写入点：`library.ts:467`（`recipe_aliases`）、`:470`（`recipe_tastes`）、`:472`（`recipe_season_months`）、`:483-487`（`recipe_ingredients`）；转正侧 `promotion.ts:165`（tastes）、`:174`（season_months）、`:198`（ingredients）、`:206`（promotions）
- 也就是说：**想让一道新菜进库，除了跑导入 CLI 或手写 SQL，没有别的办法。**

---

## 四、为什么现在这么少：spec/ADR 的意图 vs 实际数据

| 项 | spec/ADR 的意图 | 实际 | 差距的性质 |
| --- | --- | --- | --- |
| 外部池规模 | 「外部池批量打底 **150–300 道**家常菜……家里慢慢转正沉淀，**不做一次性口述冲刺**」（`docs/spec/implementation-spec.md:91`）；ADR-0006 把「一次性口述冲刺冷启动」列为**被否决的备选**（理由：家人负担重、不可持续）（`docs/adr/0006-...md:5`） | 库里 draft **11 道**，其中 9 道来自迁移 004 的「只种少量样张，够补位与 E2E 跑通」种子（`server/migrations/004_external_recipe_pool.sql:6-8`），1 道来自 008 的待重标样张，1 道来自 002 | **导入从未执行**，不是设计如此 |
| 快照 | 采集快照随仓库走，「导入结果可复现」（`server/library-data/README.md:10`） | 快照在（266 行），但与库里 id 交集 **0** | 素材备好了，落库那一步没跑 |
| 家庭库 | 「只收家里做过、掌勺者确认转正的菜」（`docs/adr/0006-...md:3`） | active **18 道**，**全部**来自 002 的 `source='oral'` 种子，`recipe_promotions` **0 行** | 这 18 道是「迁移里写死的口述菜单」，不是走转正沉淀来的——**恰好是被 ADR 否决的那条「一次性口述冲刺」的形状，只是发生在迁移里** |
| 转正 | 转正是家庭库的唯一增长机制（`docs/spec/implementation-spec.md:103`） | 0 次转正；且转正门槛（③ 必须已上桌）要求先有人把草稿菜排进菜单并吃完 | 机制在位、无人触发：先有草稿进菜单，才可能转正；草稿池只有 11 道样张，且推荐只在家位 <3 时补位（见下节） |
| 推荐池 | 每位家庭池 6–8 道候选（`MAX_FAMILY_PER_POSITION = 8`） | active 18 道分到三个位：meat 8 / veg 7 / soup 3 | 荤、素刚好卡在 8 的上限，汤位（3）**已经会触发外部补位**——但外部池只有 11 道且含 1 道待重标被过滤 |

**一句话**：ADR-0006 的「外部池打底 + 慢慢转正」这条滚雪球路径，前半段（采集快照）完成了，后半段（导入落库）**没跑**，所以雪球没滚起来；现有的 18 道家庭菜是迁移种子（口述冲刺的化石）。

---

## 五、推荐池规模的影响（`MIN/MAX_FAMILY_PER_POSITION`）

- 常量定义：`MAX_FAMILY_PER_POSITION = 8`（`server/src/domain/recommendation.ts:59`）、`MIN_FAMILY_PER_POSITION = 3`（同文件 `:63`）；两者都标了 `TODO(#26 统一收口)：进家规表`（同文件 `:58, 62`）。
- 用途：按位（荤/素/汤）取家庭池时 `slice(0, 8)`；某位不足 3 时用外部池（`listRecipes(db,'draft')`）**补到 3**。（`server/src/domain/recommendation.ts:249-260`）
- 外部补位的**具体条件与行号**：
  ```ts
  const external = rank(listRecipes(db, 'draft').filter(allowed)
      .filter((recipe) => !hasPendingRelabel(recipe)));          // :243
  ...
  const kept = family.filter(...).slice(0, MAX_FAMILY_PER_POSITION); // :250
  if (kept.length < MIN_FAMILY_PER_POSITION) {                        // :253
    const padding = external.filter(...).slice(0, MIN_FAMILY_PER_POSITION - kept.length); // :255-256
    pool.push(...padding.map((recipe) => poolEntryOf(recipe, 'external', 0)));            // :258
  }
  ```
- **含 0 克「待重标」项的草稿不进池**：`hasPendingRelabel` 是唯一判定处（`server/src/domain/recipes.ts:73-75`），`recommendation.ts:243` 与 `replacement.ts:251` 都过它。于是那 1 道 `pending_relabel_ribs` 实际**不参与**外部补位。
- **外部补位菜是否标「没做过」？是**。`poolEntryOf(recipe,'external',0)` 的 `times30d` 恒 0（「没做过」是它的定义，不是统计结果，`server/src/domain/recommendation.ts:257-258`）；界面三处都显示：
  - `web/src/routes/HomeView.tsx:520-522`（`recommend-external-<id>` 徽标「没做过」）
  - `web/src/components/CandidateList.tsx:150-152`（`candidate-external-<id>`）
  - `web/src/routes/SimpleView.tsx:439`
  - 另外选菜器里草稿菜也标「没做过」：`web/src/routes/SlotView.tsx:644`（`recipe.status === 'draft'`）
- **换菜候选同源**：`server/src/domain/replacement.ts:245-251`（`hasPendingRelabel` 过滤）、`:275-282`（`MAX_FAMILY_PER_POSITION` / `MIN_FAMILY_PER_POSITION` 补位）用同一对常量。

---

## 六、前端现状：哪些页面能看到/操作菜谱库

路由表：`/`（HomeRoute）、`/slot/:slotId`、`/grocery`、`/family`、`/review`、`*`（`web/src/App.tsx:18-70`）。**没有菜谱库页面、没有菜谱详情页路由**。

| 页面 | 菜谱相关能力 | 证据 |
| --- | --- | --- |
| `/review` 餐后回顾 | **唯一的转正入口**：草稿菜卡片上的 `PromotionForm`（口述差异 + 菜系校对 + 提交）；仅这一餐的掌勺者可见 | `web/src/routes/ReviewView.tsx:5`（`usePromoteRecipe`）、`:214-222`（只对 `status==='draft'` 渲染）、`:265, 291, 295, 314, 322, 338`（表单与 testid）、`:157-163`（canPromote） |
| `/slot/:slotId` 定餐编辑器 | 选菜器能看见**全部**菜谱（`useRecipes('all')`），草稿也能排进菜单（标「没做过」）；单道菜有**食谱弹层**（做法 + 食材清单，只读）；退役菜不上挑菜器 | `web/src/routes/SlotView.tsx:31`、`:644`、`:538-552`（食谱按钮）、`:804`（`<RecipeSheet>`）、`:858-864`（`sortForBooking` 滤掉 retired） |
| `/` 首页（三视图） | 推荐面板里外部补位菜标「没做过」；单道食谱弹层 | `web/src/routes/HomeView.tsx:440, 715`（`<RecipeSheet>`）、`:520-522`；`web/src/routes/SimpleView.tsx:439` |
| `/family` 家人管理 | 只读用到菜谱库：给家人加「爱吃」时可搜索菜谱（`useRecipes('all')`，note 固定写「家常菜」）；**不能新增/编辑菜谱** | `web/src/routes/FamilyView.tsx:594-616` |
| 换菜候选面板 | 外部补位菜标「没做过」 | `web/src/components/CandidateList.tsx:6, 150-152` |

**前端 API 客户端**：`web/src/api/recipes.ts` 只有 `useRecipes`（GET，`staleTime 60s`）；写只有 `web/src/api/promotion.ts` 的 `usePromoteRecipe`（POST promotion）。**没有任何 `useCreateRecipe` / `useUpdateRecipe` / 新增菜谱表单**（`grep -rn "新增|addRecipe|createRecipe" web/src/routes web/src/components web/src/api` 只命中「新增家人」）。

---

## 七、已知欠账（`docs/agents/open-items.md`）

与「菜谱新增/编辑/库容量」**直接**相关的条目：

1. **外部池规模与快照现状**（`:55`）：
   > 「**外部菜谱池**：`server/library-data/howtocook.jsonl`（HowToCook 采集快照，**266 道**——采集侧已按 id 去重，去重前的 372 篇里有 1 条同 id；重跑命令见 README）+ 导入 CLI（`pnpm --filter @dinnerorder/server run import:library`，参数直接跟在脚本名后、不要插 `--`）。导入完全离线；LLM 重标/菜系初打只在加 `--llm` 时发生（走 `json_object` + Zod）。」

2. **归一失败清单里约 250 条真缺字典**（`:157-162`）：
   > 「HowToCook 372 篇里仍有约 250 条食材名对不上字典（如 `印度综合香料粉`、`白芷`、`酥油`、`葱结`、`野山椒`）。它们是**不同语境下真的需要的食材**，不是杂讯……补录动作应该带一条**回填脚本/迁移**（本票没做：导入报告已把它们按出现频次排序列好了）。」
   —— 这是**导入规模的上游瓶颈**：归一失败的项不进库。

3. **0 克「待重标」的影响面**（`:139-153`）：
   > 「**外部池的 0 克项是「待重标」而不是错误**……✅ **推荐/换菜候选池这一侧已由 #19 收口**：`hasPendingRelabel`……含 0 克项的草稿**不进候选池**……**真数据实测**（调度层用真库查过）：导入后 435 个 0 克项里有 196 个是主料（虾、草鱼、鸡肉、鸡蛋、柠檬…）、239 个是调料。」
   —— 注意「导入后 435 个 0 克项」是**过去某次实验**的数字，不是当前库（当前库 1 项）。

4. **下厨房那条腿实测降级**（`:163-168`）：
   > 「站点对连续详情页请求回 **HTTP 429**：`fetch:xiachufang` 用 `--delay`（缺省 1.2s）节流，仍可能只取到 4–7 条……要更稳就得换数据源或加缓存，**不要**引入 headless 浏览器。」

5. **转正后「原始出处」没有展示位**（`:220-225`）：
   > 「转正就地改写同一行（`recipes.source` 保持 `howtocook`/`scraped`/`llm` 不变），但界面上「没做过」标记只看 `origin`……**「这道菜的原始出处」在全库没有展示位**：`GET /api/recipes` 会给出 `source`，界面没有用它。若日后要一道「来源与转正史」的详情页，账本表 `recipe_promotions` 已经在（`GET /api/recipes/:id/promotions`），接着做即可。」
   —— 这条**隐式**说明「菜谱详情页」是个尚未做的工单。

6. **家规常量（含推荐池 3/8）未落表**（`:77-84`、`:118-125`）：`MIN_FAMILY_PER_POSITION`（3）、`MAX_FAMILY_PER_POSITION`（8）等六个常量仍是实施者自定，**归 #26 收口**进 `family_rules` 单例表。

7. **「绿叶菜不留」否决时留下的一句**（`:295`）：
   > 「引入真正的绿叶菜标记（迁移加列/关联表 + 初始名单）则精确但**要先有一份「哪些算绿叶菜」的名单**，那属于菜谱库的属性扩充，性质上是新工单而不是本票的收尾。」

**没有登记**的（明确说明「没有」）：`open-items.md` 里**没有任何**关于「缺一个新增菜谱入口」「口述新增 UI」「菜谱编辑接口」的欠账条目（全文 grep `口述新增|新增菜|加菜|库容` 无命中）。也就是说：这个缺口**还没有被登记为欠账**。

---

## 八、spec / ADR 原文（关于「新菜从哪来」）

### `docs/spec/implementation-spec.md` §2.8（逐句）

- `:85` 「**家庭菜谱库** = 推荐池唯一来源：只收家里做过且掌勺者确认（转正）的菜。」
- `:86-89` 「**外部菜谱池** = 素材层，不直接进推荐池，仅当家庭池某荤素位候选 <3 时补位（标「没做过」）。来源三个：1. **HowToCook**（Anduin2017/HowToCook，Unlicense 公有领域）——许可干净，首选打底源；2. **下厨房爬取**——无开放许可，自家私用、风险自知接受，来源字段如实标「爬取」；只轻量抓家常热榜或用现成小数据集，不搞全站爬；3. **LLM 生成**——走同一条草稿管线。」
- `:91` 「**冷启动**：外部池批量打底 150–300 道家常菜（混合口味：按「家常热度 + 忌口排除」筛，不按菜系；菜系仅作参考 tag），家里慢慢转正沉淀，**不做一次性口述冲刺**。食材字典同步冷启动：WS/T 554 附录 A 互换表 + HowToCook 导入归一。」
- `:93` 「**导入工具执行细节**（开发会话交付项）：HowToCook 导入脚本、下厨房轻量取数、模糊份量（「适量」）导入/转正时一律由 LLM 重标到成人份克数。」
- `:100` 「- 治理：状态机 草稿 → 转正 → 退役（退役不进推荐、历史保留）；**来源（口述/HowToCook/爬取/LLM 生成）**；编辑留痕。」
- `:103` 「**转正机制**：外部菜谱被预定上桌 → 餐后回顾里掌勺者点「转正」→ 可口述差异（多点辣/不放蒜）→ LLM 在原菜谱上改写成家里版本 → 进家庭库 + 推荐池。」
- `:105` 「**治理**：掌勺者编辑、**全家提议**（提议归属当前身份）、掌勺者确认生效；无真鉴权，靠约定 + UI 引导。」
- `:24`（AC 表 S6）「家庭池某荤素位候选 <3 时外部菜谱补足并显著标「没做过」；该菜上桌后掌勺者可在餐后回顾点「转正」，改写差异后进入家庭库与推荐池」

**spec 规定的入口是什么**：外部池的**唯一**入口是「HowToCook 导入 / 下厨房轻量抓取 / LLM 生成**走同一条草稿管线**」（`:86-89`、`:93`），规模目标 150–300 道（`:91`）；家庭库的增长只有「转正」（`:103`）。**spec 没有规定「口述新增一道菜的 UI」**——`口述` 在 §2.8 只出现两次：一次是 `source` 枚举里的一个值（`:100`），一次是转正时「可口述**差异**」（`:103`，改的是已有菜，不是新增）。§2.8 那句「掌勺者编辑、全家提议」的「编辑/提议」**在代码里没有任何实现**（见下节）。

### `docs/adr/0006-two-tier-recipe-library-with-promotion-gate.md`（逐句）

- `:3` 「菜谱库分两层：**家庭菜谱库**只收家里做过、掌勺者确认转正的菜，是整餐推荐与换菜候选的唯一来源；**外部菜谱池**（HowToCook / 下厨房爬取 / LLM 生成）是素材层，仅当家庭池某荤素位候选不足 3 时补位进入候选（显著标「没做过」），上桌后经餐后回顾的「转正」动作——掌勺者确认、可口述差异由 LLM 改写成家里版本——才进家庭库与推荐池。状态机：草稿 → 转正 → 退役（退役不进推荐、历史保留）。」
- `:5` 「理由：「家里做过、家人吃过」是推荐信任的根——池子小而可信比大而参差更符合「10 分钟顶下一餐」的产品目标；转正流程让家庭口味随日常使用自然沉淀为核心资产；下厨房数据的许可风险（无开放许可，私用风险自知）被隔离在素材层，不扩散到推荐面。**被否决的备选**：单一全量库直接推荐（多样性强，但没做过的菜频繁上桌、外部数据质量与许可问题直接进推荐面）；**一次性口述冲刺冷启动（家人负担重、不可持续——外部池打底慢慢转正才能滚起来）**；按菜系筛选导入（家里是混合口味，「家常热度 + 忌口排除」才筛得出家常）。」

**ADR 的意图**：新菜**不该**靠「口述冲刺」进来，而应靠「外部池打底 + 慢慢转正」。**代码与此一致**（没有口述新增入口），**数据与此不一致**（18 道家庭菜全是迁移里的口述种子，外部池从未打底）。

---

## 九、代码里**不存在**的路径（明确写「没有」）

1. **没有任何「新增一道菜」的 HTTP 接口**。`server/src/api/*.ts` 里注册的全部路由（逐条，`grep -n "api\.\(get|post|put|patch|delete\)(" server/src/api/*.ts`）：
   - `family-rules.ts:46,48`：`GET /family-rules`、`PATCH /family-rules`
   - `feedback.ts:58,71,76`：`POST /feedback`、`GET /feedback`、`DELETE /feedback`
   - `grocery.ts:44,55,61,67,76,87`：`GET /grocery`、`POST /grocery/recalculate`、`POST /grocery/archive`、`POST /grocery/items`、`PATCH /grocery/items/:id`、`DELETE /grocery/items/:id`
   - `health.ts:15`：`GET /health`
   - `ingredients.ts:13`：`GET /ingredients`
   - `members.ts:96,98,108,144,154`：`GET /members`、`GET /members/:id`、`POST /members`、`DELETE /members/:id`、`PATCH /members/:id`
   - `portion.ts:66,68,70,82`：`GET /portion/rules`、`GET /portion/exchange`、`GET /portion/exchange/convert`、`POST /portion/preview`
   - `recipes.ts:50,55,69,83,89`：`GET /recipes`、`GET /recipes/:id`、`GET /recipes/:id/recipe`、`GET /recipes/:id/promotions`、**`POST /recipes/:id/promotion`（唯一的菜谱写接口）**
   - `recommendations.ts:27`：`POST /slots/:id/recommendation`
   - `replacements.ts:42`：`POST /slots/:id/candidates`
   - `slots.ts:119,136,141,163,183,214,240`：`GET /slots`、`GET /history/recent-dishes`、`GET /slots/:id`、`GET /slots/:id/nutrition`、`PUT /slots/:id`、`DELETE /slots/:id`、`POST /slots/:id/undo-set`
   → **没有 `POST /recipes`，没有 `PUT/PATCH /recipes/:id`。**（`server/src/api/recipes.ts:21-24` 的注释也自陈：「转正之外仍然没有『直接改菜谱』的路」）
2. **没有任何编辑已转正（active）菜谱的接口**。转正只接受 `status==='draft'`；对 active 调用会 409 `not_draft`。想让家里菜谱变个做法，代码里没有路径（连 `PATCH` 都没有）。
3. **没有退役（retire）接口**。`status='retired'` 只出现在迁移种子（002 的 `xiangjiandaiyu`）与测试里，`server/src` 没有任何把 `status` 写成 `'retired'` 的非测试代码（`grep -rn "retired" server/src/api server/src/domain` 只命中读取与报错）。
4. **没有「提议（proposal）」相关的表或接口**。全仓库 grep `提议|proposal|propose` 只命中 **1 处**：`docs/spec/implementation-spec.md:105` 的「全家提议（提议归属当前身份）」——**代码、迁移、前端零实现**（`grep -rn "提议\|proposal\|propose" server/src web/src` 无结果）。
5. **没有菜谱详情页路由**（`web/src/App.tsx` 的 5 条路由里没有 `/recipes*`）；最接近的是 `RecipeSheet` 弹层（只读做法 + 食材）与 `GET /recipes/:id/recipe`。
6. **没有新增菜谱的 UI**：`web/src/routes/` 下 `FamilyView` 的「+ 新增家人」是唯一的新增表单（`FamilyView.tsx:41-49`），菜谱只有只读消费。
7. **没有 HTTP 入口能触发导入**：`import-library.ts:4-5` 明写「为什么是脚本而不是 API 路由：导入是**离线批处理**……放进 HTTP 只会多一条能被误触的写库入口」；`server/library-data/README.md:4`「导入是**离线批处理**（ADR-0006：外部池是素材层），不进产品界面、没有 HTTP 入口」；`README.md:37` 同口径。
8. **没有「从 HowToCook 仓库在线拉取」的路**：`import-library.ts` 只吃本地文件（`--from` 快照 / `--xcf-dir` 目录）；取数是独立且**有界**的两条命令（`git clone` 手动 + `pnpm ... fetch:xiachufang`，`server/scripts/fetch-xiachufang.ts:1-18`）。

---

## 十、dry-run 实测（2026-09-20，主会话执行）

**怎么跑的（零风险）**：先 `sqlite3 data/dinner.db "VACUUM INTO 'data/import-dryrun.db'"` 复制一份生产库，再对**副本**跑 dry-run（`--db data/import-dryrun.db --report data/import-dryrun-report.json`）。

```bash
cd /Users/chenjingjing/DinnerOrder
sqlite3 data/dinner.db "VACUUM INTO 'data/import-dryrun.db'"
pnpm --filter @dinnerorder/server run import:library \
  --from server/library-data/howtocook.jsonl --dry-run \
  --db data/import-dryrun.db --report data/import-dryrun-report.json
```

为什么不直接对生产库跑：dry-run 缺省的 `--db` 是 `data/dinner.db`，而且脚本开头就 `runMigrations`（会写库）——即使事务回滚，也不该让离线批处理碰到正在服务的生产库。（来源：`server/scripts/import-library.ts:83, 193-195`）

**耗时**：0.59 秒（纯规则，未开 `--llm`）。

**实测数字**：

| 项 | 数值 | 备注 |
| --- | --- | --- |
| 会落的草稿 | **246 道** | meat 151 / veg 73 / soup_meat 12 / soup_veg 10 |
| 被拒 | **20 条** | 13 条菜名撞车（8 家庭菜 + 5 草稿）+ 7 条「食材名全都没对上字典」 |
| 归一失败清单 | **254 个名字 / 305 次出现** | 其中 **226 个名字只出现 1 次**，只有 9 个名字出现 ≥3 次 |
| 份量重标 | needed **2000** / done **1564** / 覆盖率 **78.2%** | 待重标 **436 项**，涉及 175 道菜 |
| 时令手工表 | 40 种食材 × 12 月 | 形状断言通过 |

**关键推论（对「要不要开 `--llm`」有直接决定作用）**：

- 246 道里有 **174 道**含至少 1 个 0 克项 → 不开 `--llm` 时被 `hasPendingRelabel` 挡在推荐池外；只有 **72 道**（meat 47 / veg 17 / soup_meat 4 / soup_veg 4）导入后立刻可用。（来源：`server/src/domain/recipes.ts:73-75`；`server/src/domain/recommendation.ts:243`）
- 待重标的 436 项里 **435 项属于本批**，1 项属于既有的 `pending_relabel_ribs`。
- **开了 `--llm` 也不是全清**：重标是逐菜分组（`batchSize = 6`，175 道 → **30 批**），每批 `maxAttempts = 2` × `timeoutMs = 60s` → **最坏 60 次调用、上限约 60 分钟**；菜系初打另加 21 批（`batchSize = 12`）。（来源：`server/src/domain/library.ts:654-697`；`server/src/llm/import-schema.ts:117, 215-225`）
- 本地 LLM 端点 `127.0.0.1:8004` **可达**（`curl --max-time 5 .../v1/models` → HTTP 401，即服务在跑、只是探测未带 key）。

**撞车面修正**：第三节推算的「约 253 道新草稿」**实际是 246 道**。差额来自两点：13 道菜名撞车（与推算一致），以及 **7 道菜因「食材名全都没对上字典」被整道拒掉**（不是静默丢食材，是 `NormalizationError`）——那 7 道的原文长这样：`食材名全都没对上字典：主料、调料、香料包` / `带皮羊排、青椒，甜椒 各` / `一般、水的体积是米饭的体积的、油的质量 Mo` / `面类材料、冷水、菜类` / `一般` / `叶菜类蔬菜` / `不粘锅、铁锅`。**这 7 条不是缺字典，是采集解析把菜谱正文的小标题当成了食材名**——补别名没用，属采集器的问题。（来源：`server/src/domain/library.ts:325`；`data/import-dryrun-report.json` 的 `rejected`）

**归一失败的 254 个名字里，真缺字典 vs 解析噪音要分开看**（这是补字典工作量的分母）：

| 类别 | 例子 | 条数（出现 ≥3 次的 9 个） | 处置 |
| --- | --- | --- | --- |
| **真缺字典（常见食材）** | `芝麻`(8×，字典只有 `白芝麻`/`黑芝麻`)、`米饭`(6×，字典只有 `大米`/`米粉`)、`猪肉`(4×，字典只有 `猪排骨`/`猪梅花肉`/`猪肉末`)、`鸡肉`(3×，字典只有 `鸡胸肉`/`鸡腿`/`鸡翅`)、`小苏打`(2×)、`芥末`(2×)、`白葡萄酒`(2×)、`酥油`(2×)、`南乳`(2×)、`肉蟹`(2×) | 见左 | **补别名就能救**（`INSERT OR IGNORE INTO ingredient_aliases`），是有效工作量 |
| **解析噪音（不是食材）** | `盐量 = 份数`(5×)、`肉量 = 份数`(3×)、`盐的用量为`(3×)、`酱汁部分`(2×)、`米饭部分`(2×)、`温水 约`(2×)、`不粘锅`、`铁锅` | 见左 | **补字典没用**，要改采集器（`parseHowToCook`） |
| **错别字** | `耗油`(2×，应为 `蚝油`——字典里有 `蚝油`) | 2× | 补一条别名即可（这是**最划算**的一类：一处修复换 2 次命中） |

**丢掉的食材项**：本批 246 道的原始食材项合计 **2305**，归一后落库 **1971**，**334 项被丢**；其中 **159 道菜**至少丢了一项、**87 道菜**一项没丢。（报告 `unmatched` 的 305 次是含被拒 13 道的口径，与 334 的差来自「同菜内重复项」的计数口径不同——两者都已在报告里可复算。）

**副产物**（`data/` 已 gitignore，不进仓库）：`data/import-dryrun.db`（副本，471 KB）、`data/import-dryrun-report.json`（报告，157 KB）。

---

## 十一、未验证项

1. ~~**`data/dinner.db` 与 `data/dinner.dev.db` 的「活跃实例」关系**~~ → **已由主会话查证**（2026-09-20）：生产是 `data/dinner.db`（launchd plist 的 `DB_PATH` + `ps eww` 双证，见第二节）。子代理当时没有查进程，故留为未验证项；本节保留以记录推理路径。
2. **`data/import-report.json` 从未生成**：我以「文件不存在」推断「导入 CLI 从未对真库跑过」。反向可能：跑过但被删了、或用了 `--report` 指到别处。**没有**检查 `backups/` 或别处是否有报告副本（时间边界内没做）。
3. **`open-items.md:139-153` 的「导入后 435 个 0 克项 / 约 250 条归一失败」是历史实验数据**，来源库不明（该行自陈「调度层用真库查过」）；当前库只有 1 个 0 克项。这两组数字的**时间点与库路径未验证**。
4. **那 266 道快照导入后会剩多少**：没有实跑（硬规则禁跑 pnpm），所以「导入后外部池会变成多少道」是**推算而非实测**——已知瓶颈是约 250 条归一失败项会被拒（`open-items.md:157-162`），以及 0 克项在开 `--llm` 前不进推荐池。

   **已实测的撞车面**（补充，主会话查证）：快照 266 道里有 **13 道菜名与库里现有菜名相同**——8 道是家庭菜（`清蒸鲈鱼`/`白灼虾`/`可乐鸡翅`/`糖醋里脊`/`蚝油生菜`/`蛋炒饭`/`黄焖鸡`/`上汤娃娃菜`，全 `active`，会被 `rejected`「已被家庭菜谱占用，不能覆盖」），5 道是草稿（`回锅肉`/`宫保鸡丁`/`香菇滑鸡`/`紫菜蛋花汤`，`howtocook`；`凉拌黄瓜`，`llm`——它们本来就是 004 从同一批快照里挑的种子）。缺省 `skip` 模式下这 13 道进 `rejected` 清单，剩下约 253 道是新草稿。**注意 `--replace` 也不会动那 8 道家庭菜**（`library.ts:408-420, 432-444`）。
5. **`e2e-root.db` / `e2e-sub.db` / `e2e-llm-down.db` 未查**（E2E 夹具库，与结论无关）。
