# 外部池观察轮：外部菜到底会不会滚起来

日期：2026-09-20 ｜ 性质：**观察计划 + 查询集**（本轮不动任何机制代码） ｜ 期末：**2026-09-27**

---

## 1. 为什么是「观察」而不是「改机制」

2026-09-20 的 grilling 会话（交割文件 `handoff-external-pool-2026-09-20.md`）把「外部菜一道都推不到」的判断**推翻**了。算术（`server/src/domain/recommendation.ts` 的 `buildPool`，去重先于取池）：

- 荤位家庭池 8 道、每餐要 4 道（4 大人 + 2 小孩）→ **第 3 餐起 8 道全进 7 天去重窗口**，`kept=0`，补 3 道外部菜且荤位缩水成 3 道（`recommendation.ts:361`「荤菜候选不够」）；
- 外部菜上桌后同样进去重窗口 → 第 4 餐再换 3 道新的外部菜；
- 直到 09-27 前后，09-20 午餐的 4 道陆续滚出窗口回归。

**结论：补位机制即将大量触发，不是永不触发。** 此时改门槛（调 `MIN_FAMILY_PER_POSITION` 或固定配额）是无数据拍脑袋——先看一周真实数据。

> 注意：若将来要调门槛，落点早已铺好——`MIN/MAX_FAMILY_PER_POSITION` 归 #26 家规收口（进 `family_rules` 单例表，代码里 TODO 已标）。

## 2. 验收标准与升级条件

- **验收（「外部池真用起来」）**：至少一道外部菜走完**转正闭环**——上桌（推荐补位或手动加菜）→ 吃 → 餐后回顾里掌勺者确认转正 → 进家庭池。转正链路代码 #21 已交付（`POST /recipes/:id/promotion`，入口在 ReviewView），成败取决于人用不用，不是代码堵。
- **升级条件（期末检查，任一触发即重开门槛讨论——方向一）**：
  - 观察期内外部菜**上桌 < 2 道**（推荐面/加菜器都没让人把外部菜端上桌）；
  - 外部菜上桌 ≥ 2 道 but **转正 0 道**（上桌了但没人走回顾转正——此时先查转正入口的可见性，再谈门槛）。

## 3. 基线快照（2026-09-20，观察期起点）

| 指标 | 值 |
| --- | --- |
| 家庭池（active） | meat 8 / veg 7 / soup 3（soup_meat 2 + soup_veg 1）—— 全部 `source=oral` |
| 草稿池（draft） | 257 道（meat 156 / veg 77 / soup 24）—— 全部导入（howtocook 254 + llm 1 + scraped 2） |
| 外部菜上桌 | **0** |
| 转正累计 | **0** |
| 已定菜单 | 09-20 午餐（6 道：荤 4 / 素 1 / 汤 1）；09-20 晚餐最新留痕为 cancel（当前未定） |

## 4. 期末查询集（照抄执行，结果回填 §6）

**① 外部菜上桌几道、哪几餐**（`recipes.source` 转正后不变，口径稳定；排除 cancel 事件）：

```bash
sqlite3 data/dinner.db "
select me.slot_id, group_concat(r.name, '、') as dishes
from meal_event_dishes d
join meal_events me on me.seq = d.seq
join recipes r on r.id = d.recipe_id
where r.source in ('howtocook','scraped','llm')
  and me.slot_date >= '2026-09-20' and me.slot_date <= '2026-09-27'
  and me.type != 'cancel'
group by me.slot_id order by me.slot_id;"
```

**② 转正几道、谁点的**：

```bash
sqlite3 data/dinner.db "
select r.name, p.promoted_at, p.differences
from recipe_promotions p join recipes r on r.id = p.recipe_id
where p.promoted_at >= '2026-09-20' order by p.promoted_at;"
```

**③ 每餐荤位数（<4 = 家规要 4 道荤而实际缩水；按每槽最新事件数，避开中间态）**：

```bash
sqlite3 data/dinner.db "
with last as (select slot_id, max(seq) s from meal_events where slot_date>='2026-09-20' group by slot_id)
select me.slot_id, count(*) as meat_n
from last join meal_events me on me.seq=last.s
join meal_event_dishes d on d.seq=me.seq
join recipes r on r.id=d.recipe_id
where me.type!='cancel' and r.kind='meat'
group by me.slot_id having meat_n < 4 order by me.slot_id;"
```

**④ 家庭池规模变化（转正的直接效果 + 退役）**：

```bash
sqlite3 data/dinner.db "select kind, status, count(*) from recipes where status!='draft' group by kind, status;"
```

**⑤ 加菜器手动路径的使用**（manual 定餐里含外部菜 = 手动上桌发生）：

```bash
sqlite3 data/dinner.db "
select me.slot_id, r.name from meal_event_dishes d
join meal_events me on me.seq=d.seq join recipes r on r.id=d.recipe_id
where r.source in ('howtocook','scraped','llm') and me.source='manual'
  and me.slot_date>='2026-09-20' and me.type!='cancel' order by me.slot_id;"
```

## 5. 人工观察项（库里有不下的事）

- 推荐面上「荤菜候选不够，本餐配了 N 道荤菜」提示**出现的餐次**（推荐响应不落库，只能看界面时留意）；
- 外部菜出现在推荐里时，家人第一反应（接受 / 换掉 / 无感）—— qualitative，记两三句就行；
- 加菜器当前 257 按钮平铺**实际上没人用**的挫败感有多强（佐证下轮改造的优先级）。

## 6. 结果回填（2026-09-27 填）

| 指标 | 值 | 备注 |
| --- | --- | --- |
| ① 外部菜上桌 | _待填_ | |
| ② 转正 | _待填_ | |
| ③ 荤位缩水餐次 | _待填_ | |
| ④ 家庭池变化 | _待填_ | |
| ⑤ 手动上桌 | _待填_ | |
| 人工项 | _待填_ | |
| **结论：通过 / 升级讨论** | _待填_ | |

## 7. 本轮同时定案、归下轮的工单（详录 open-items.md）

1. **加菜器搜索 + 筛选**：菜名搜索 + 菜系/难度筛选 + 按主料（食材）搜索 + 做过/没做过筛选；「没做过」判定 = `status=draft`（与现有小标、CONTEXT.md「origin（草稿=external）」同口径，不引第二套）。
2. **字典补录（扁平 + 三件套）**：新增裸名基础条目（猪肉/鸡肉/芝麻/米饭…，带时令月份）+ `ingredient_contains` 指针连部位（猪排骨→猪肉，忌口自动向上传播，机制现成）+ 子类（品种）不入库；44 条杂讯（「盐量 = 份数」类）在采集/解析侧过滤；然后 `--replace --llm` 重刷草稿（重标会重跑，分钟级）。「姜蒜」类连写名归解析侧拆分，不进字典。

   ✅ **已实施（issue #28，2026-09-20）**。落地面：迁移 `server/migrations/013_ingredient_base_entries.sql`、
   清洗与归一 `server/src/domain/library.ts`。实测（对生产库副本跑 `--replace --llm`）：
   归一失败 **254 → 136 个名字**（305 → 142 次出现）、杂讯 28 条进报告的 `dropped` 清单、
   0 克项 **456 → 0**（重标 2178/2178 = 100%）、家庭菜谱 18 行与逐食材克数**逐行一致**。
   三条实施中的判断已记进 `docs/agents/open-items.md` 的「下轮工单 2」节：
   时令表本轮无新增（新增条目全是四季常售的肉/禽/主粮/调料）、「A 或 B」的专用归一机制
   试过后删掉（真实数据零收益，包含匹配已够）、「只有调料没有主料」的 18 道草稿不是本票引入的。
