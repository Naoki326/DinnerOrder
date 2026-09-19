# 采集器夹具（测试用，不碰网）

采集器的测试吃这些文件——**「导入器对不对」与「今天能不能连上 GitHub / 下厨房」是两件独立的事**。

| 文件 | 来源 | 处理 |
| --- | --- | --- |
| `howtocook-disanxian.md` | HowToCook（Anduin2017/HowToCook）`dishes/vegetable_dish/地三鲜/地三鲜.md` | 原文照抄（Unlicense 公有领域，无许可顾虑） |
| `howtocook-baizhuoxia.md` | HowToCook `dishes/aquatic/白灼虾/白灼虾.md` | 原文照抄 |
| `xiachufang-detail.html` | 下厨房某菜谱详情页 | **手工缩减**：只留解析依赖的 DOM 形状，正文删到「够验解析」为止 |
| `xiachufang-explore.html` | 下厨房「本周最受欢迎菜谱」热榜页 | **手工缩减**：只留六条卡片（真页 25 条），形状一致 |

下厨房两个夹具缩减的理由：它**无开放许可**（ADR-0006 的决定是自家私用、风险自知），
把整页 HTML 抄进仓库等于把那份风险从素材层扩散到代码库。夹具只需要形状，不需要正文。

上游改版会让形状变化——那时夹具与解析要一起改，`src/library/collectors.test.ts` 会当场红。
真数据跑批的口径由 `src/library/import-report.test.ts` 对着
`server/library-data/howtocook.jsonl` 快照验（150–300 道的量级、来源字段、报告三块数字）。
