# 冷启动导入的数据与工具链（M1-07）

本目录与 `server/src/library/`、`server/scripts/` 一起构成总纲 §5 的「外部菜谱池从近零到可用」。
导入是**离线批处理**（ADR-0006：外部池是素材层），不进产品界面、没有 HTTP 入口。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `library-data/howtocook.jsonl` | **HowToCook 采集快照**（每行一道 `DraftRecipe`，266 道；采集侧已按 id 去重）。导入的唯一输入，随仓库走——于是「导入结果可复现」不依赖「今天 GitHub 连得上」 |
| `src/library/collectors.ts` | 采集器（纯解析，不碰网）：HowToCook markdown / 下厨房 HTML / LLM 生成草稿 |
| `src/library/__fixtures__/` | 采集器的测试夹具（真实抓下来的原文） |
| `src/domain/library.ts` | 归一（对食材字典）+ 落库为草稿 + LLM 重标/菜系初打 + 报告 |
| `src/llm/import-schema.ts` | 导入期的 LLM 出参形状与提示词（`json_object` + Zod 校验 + 重试） |
| `scripts/import-library.ts` | CLI：采集成快照（按 id 去重）/ 导入 / dry-run |
| `scripts/fetch-xiachufang.ts` | 有界抓下厨房热榜与详情页（唯一碰站点的一步）：产出 `<dir>/<序号>-<菜名>.html` **加 `<dir>/manifest.json`（菜名 + 真 URL）** |

## 筛选口径（§2.8、ADR-0006：**不按菜系**）

`parseHowToCook` 的三条可判定规则：

1. **家常目录**：`meat_dish` / `vegetable_dish` / `soup` / `staple` / `aquatic` 进；
   `breakfast` / `drink` / `dessert` / `condiment` / `semi-finished` 不进（早餐不进模型，饮品甜点不是菜）。
2. **家常耗时**：原文 `预估烹饪难度：★★★` 且菜名没有快手/懒人/简易字眼的判 `heavy`——
   仍然进池（费事菜也有它的位置），只是推荐排序里靠后。
3. **忌口粗筛**：名字命中内脏/贝类/生食/苦瓜那批白名单的直接跳过。
   这是**导入期的素材过滤**，不替代推荐期的硬过滤（那个由食材字典推导，永远生效）。

菜系（`cuisine`）只作参考 tag，**从不参与筛选**——`cuisineHintFrom` 能给确定值就给，
给不出留 `null` 等 LLM 初打，仍给不出就等 #21 转正时掌勺者校对。

## 份量：「适量」一律不猜

采集时只有原文写明了**重量单位**（g/斤/两/公斤/ml）才落 `adultGrams`；其余（「两勺」「3 瓣」
「适量」）落 `null` → 落库为 **0 克**（迁移 005 把 `adult_grams` 的 CHECK 放宽为 `>= 0`，
**0 = 待重标**）→ 报告里的 `relabel.pending` 列出 → `--llm` 时由 LLM 批量重标写回正数。

份量原文（「1 只（大约 300g） * 份数」「适量」）一并落在 `recipe_ingredients.source_quantity`
（迁移 005）：它是**重标的证据**（`llm/import-schema.ts` 的提示词纪律 2：模型看到的是原文，
不是我们替它猜的数）与报告 `relabel.pending` 的显示内容，**不进份量计算**。

`relabel.coverage` 的分母是草稿里的**全部**食材项（不是「待重标项」），
所以它只会随重标进度上升、不会因为分母缩小而虚高。

## 时令手工表（§5：30–40 种常买食材 × 12 月）

表在迁移 `005_import_toolchain.sql` 的 `ingredient_season_months` 里，**40 种**常买食材。
口径是 002 留下来的那条：**只录「当季」月份，未录 = 未录/四季有售**。
「× 12 月」指这份表的形状是 40 行 × 12 列的网格（每一列都有食材落上去，
`domain/library.ts` 的 `seasonGrid()` 读它）——**不是**给每个食材填满 12 个月：
填满等于把时令信号抹成常量，推荐排序的时令位就永远是同一个分。

维护方式：直接改迁移里的 `INSERT OR IGNORE` 列表（新食材另起一次迁移追加），
用 `pnpm test` 里的 `server/src/domain/library.test.ts`「时令手工表」一节兜住形状
（种数 30–40、12 列非空）。

## 下厨房那条路：真 URL 只在 manifest 里

`--xcf-dir` 指向的目录必须带 `fetch:xiachufang` 写的 `manifest.json`——`sourceRef`（报告里留着
回溯的页面地址）与草稿 id 的 key 都从它的 `url` 来。**不从文件名序号拼 URL**：序号是本地落盘
顺序，不是页面编号，拼出来的地址是假的（而「来源字段如实」是 AC）。缺 manifest / 形状不对时
导入如实降级：这条腿不可用，HowToCook 那一路照常跑（`--from` 仍可用）。

## 归一失败的处置

`data/import-report.json` 的 `unmatched` 是**跨本次导入按出现次数降序**的清单
（`name` / `dishes` / `occurrences`）。真数据跑下来仍有约 250 条，
它们是真的缺字典条目，不是杂讯。处置办法就一条：**往迁移里补别名或食材行**，然后重跑导入
（导入是幂等的：同 id 已有草稿就跳过，不会越导越多）。
不要为了让报告好看去放松归一规则——「猜」错一个食材名的代价是把忌口关联挂错
（隐性忌口靠食材清单展开），宁可在清单里列出来让人处理。
