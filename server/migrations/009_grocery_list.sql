-- M1-11 买菜清单（总纲 §2.7、§3；spec S8）
--
-- 总纲 §2.7 的第一句就是「**物化实体**，状态：进行中 / 已归档」——所以清单要落库，
-- 不能每次现算。落库的不是「聚合算法」（那是读已定餐现算的），而是聚合的**结果**：
-- 勾选态、手工行、过期标记这三样不属于任何一餐、也不属于任何菜谱，现算没有地方存它们。
--
-- 三张表，对应总纲 §2.7 的行两种：
--
--   * `grocery_lists`  —— 清单本体：状态、是否过期（+ 原因）、创建/重算/归档时刻。
--     **同时只能有一份进行中清单**：局部唯一索引钉死（SQLite 直接支持带 WHERE 的唯一索引）。
--     没有可变的「当前清单指针」列，也就没有指针飘走的机会。
--
--   * `grocery_items`  —— 两种行共用一张表、靠 `kind` 区分：聚合行（`ingredient_id` + 克数）
--     与手工行（自由文本，`ingredient_id`/`grams` 为 NULL）。共用一张表的理由与 meal_events
--     的 diners/dishes 子表同一路数：勾选、排序、删除这三种操作对两种行是**同一套**，
--     分两张表就要把每个操作写两遍（而它们的 CHECK 又几乎一样）。
--     CHECK 把「聚合行 ⟺ 有食材 id 与克数」钉死：手工行没有克数（掌勺者没量），
--     聚合行没有克数就是一条没有意义的行。
--
--   * `grocery_item_sources` —— 聚合行的来源：这一份食材来自哪几餐的哪道菜（原型 v1 行内
--     那串「来自 N 道菜：明天午餐·红烧排骨」）。存 slot_id + recipe_id 而不是把渲染好的
--     字符串存下来：菜名改了（家里改名/转正改写）行内的来源也该跟着变；日期与餐次从
--     slot_id 解析即可，不另存两份会漂移的字段。菜谱行不删（退役也保留），所以是 RESTRICT。
--
-- 过期语义（总纲 §2.7）：**改餐 → 标记过期 → 手动重算**。标记过期只改 stale 与原因，
-- 不动行——过期清单上的勾选与手工行正是重算要继承的东西（勾选按食材继承、手工行保留）。
-- `CHECK ((stale = 1) = (stale_reason IS NOT NULL))`：过期必有原因，因为界面上要写
-- 「⚠️ （原因），清单过期了」——一个说不清为什么过期的清单等于没有过期标记。
--
-- 原因存**结构**而不是渲染好的中文，两列：`stale_reason`（枚举短码：改了什么）+ `stale_slot_id`
-- （哪一餐）。界面那句话由读接口/界面现拼——把中文存下来有两个必然的坑：改文案 = 改历史数据；
-- 而「今天午餐」这种相对叫法会随时间漂移（昨天存的串说的是昨天的事，永远对不回当时那一餐）。
-- 槽位那一半也是结构：槽位类原因必须带槽，家规改动（没有具体餐）必须不带。
--
-- 本票不落「每餐建议量」（WS/T 554 表 3/4）：台账已判定不必单独录（与已录的宝塔推荐量篮
-- × 餐次占比重叠），本票的清单按**菜谱食材生重聚合**（总纲 §2.7），不依赖它。

CREATE TABLE grocery_lists (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 进行中 / 已归档（归档 = 这一趟买完了，清单连同它的勾选态一起封存）
  status           TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  -- 改餐后标记过期：清单还在、勾选还在，但已经与当前菜单对不上（等一次手动重算）
  stale            INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  -- 为什么过期：枚举短码（**不是渲染好的那句中文**，见文件头的「原因存结构」）。
  -- 值域封闭：新增会改变聚合的写路时要在这里加一档，否则清单会静默不过期。
  stale_reason     TEXT CHECK (stale_reason IN ('menu_changed', 'cancelled', 'set_undone', 'family_rules_changed')),
  -- 哪一餐的菜单变了：槽位类原因才有（警告卡那句「今天午餐的菜单变了」的主语）；家规改动没有具体餐
  stale_slot_id    TEXT,
  created_at       TEXT NOT NULL,
  -- 最后一次重算的时刻（创建时与 created_at 同一个值：新清单就是一次聚合的结果）
  recalculated_at  TEXT,
  archived_at      TEXT,
  -- 这份清单聚合了几餐：界面上「进行中 · N 餐」的那个 N（「吃剩的」那一餐不加采购，不计入）
  meal_count       INTEGER NOT NULL DEFAULT 0 CHECK (meal_count >= 0),
  -- 过期必有原因，未过期必无原因（界面上原因要看得见）
  CHECK ((stale = 1) = (stale_reason IS NOT NULL)),
  -- 槽位那一半也要成对：槽位类原因必须带槽（否则警告卡缺主语），家规改动必须不带（否则多一个说不清的餐）
  CHECK ((stale_slot_id IS NULL) = (stale_reason IS NULL OR stale_reason = 'family_rules_changed'))
);

-- 同时只能有一份进行中清单：局部唯一索引的键在过滤后是同一个常量，于是第二份插不进来。
-- 归档的清单不占这个位置（想归档多少份都行，那是历史）。
CREATE UNIQUE INDEX idx_grocery_lists_active ON grocery_lists (status) WHERE status = 'active';
CREATE INDEX idx_grocery_lists_archived ON grocery_lists (archived_at) WHERE status = 'archived';

CREATE TABLE grocery_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id       INTEGER NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
  -- 聚合行 / 手工行（总纲 §2.7 的两种行）
  kind          TEXT NOT NULL CHECK (kind IN ('aggregate', 'manual')),
  -- 聚合行指向食材字典（字典是全库唯一受控表；对不上字典的食材不进聚合）
  ingredient_id TEXT REFERENCES ingredients(id),
  -- 聚合行的规范名（快照一份，清单读起来不必再 join 字典）；手工行就是掌勺者写的自由文本
  name          TEXT NOT NULL,
  -- 聚合行的生重合计（g）；手工行没有克数（掌勺者只写名字，没量）
  grams         REAL,
  -- 逐行勾选（买到了打个勾）
  checked       INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  -- 「这个食材在菜里，但克数还没定」：导入期的模糊份量（迁移 005：adult_grams = 0 待 LLM 重标）。
  -- 这类项**列出并标记**而不是静默跳过——0 g 不是「不需要买」，是「还不知道买多少」
  -- （台账「归属 #19」点名 #23 要有态度）。重标写回正数后重算一次，标记自然消失。
  needs_relabel INTEGER NOT NULL DEFAULT 0 CHECK (needs_relabel IN (0, 1)),
  position      INTEGER NOT NULL,
  -- 聚合行 ⟺ 有食材 id 与克数；手工行两者皆无（总纲 §2.7 的两种行是互斥的形态）
  CHECK ((kind = 'aggregate') = (ingredient_id IS NOT NULL)),
  CHECK ((kind = 'aggregate') = (grams IS NOT NULL)),
  -- 待重标只对聚合行有意义（手工行是掌勺者临时写的名字，没有「克数待定」这回事）
  CHECK (kind = 'aggregate' OR needs_relabel = 0),
  UNIQUE (list_id, kind, position)
);

CREATE INDEX idx_grocery_items_list ON grocery_items (list_id, kind, position);

CREATE TABLE grocery_item_sources (
  item_id   INTEGER NOT NULL REFERENCES grocery_items(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  -- 'YYYY-MM-DD:lunch|dinner'（日期与餐次从它解析，不另存会漂移的两份）
  slot_id   TEXT NOT NULL,
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  PRIMARY KEY (item_id, position)
);

CREATE INDEX idx_grocery_item_sources_recipe ON grocery_item_sources (recipe_id);
