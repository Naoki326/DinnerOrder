-- M1-04 份量引擎（总纲 §3 决议 2、§5；ADR-0004）
--
-- 份量 = 菜谱**成人份生重基准** × Σ用餐者**折算系数** × 留量上浮（本票无留量标记，上浮恒 1）。
-- 纯规则查表，LLM 不进数值路径（ADR-0004）。本票落四块规则资产 + 两块互换表：
--
-- 1. **成人能量锚点**（portion_adult_anchors）：折算系数的分母。成人男女不在 WS/T 554 内，
--    取 DRIs 轻活动的通行值（男 2250 / 女 1800 kcal）——出处是纸书、书未开放，
--    source 里写明来源缺口（findings open question 3）。
--
-- 2. **年龄分带系数**（portion_age_bands）：儿童系数 = 同性别儿童全天能量 ÷ 同性别成人锚点。
--    6–17 岁的能量来自 WS/T 554—2017 表 1（唯一一份按男/女拆开的政府行标级分带能量表）；
--    2–5 岁没有分性别的能量表，用妇幼营养分会学龄前宝塔的推荐量篮比值推导，
--    数值来自官方图 OCR、**尚未对照原图复核**（findings open question 2，source 里标注）。
--
--    **存储裁决**：绝对量（能量 / 推荐量）是权威列，系数是它的**派生列**，两者都落库——
--    系数让 #22/#23 可以直接取用，绝对量让推导链可复算（测试按「能量 ÷ 锚点」自洽校验）。
--
-- 3. **逐带参考能量**（portion_reference_energy）：WS/T 554 表 1 原值，与 6–17 岁的带一一对应。
--    单独一张表而不是塞进 band 的列：它是**外部标准原值**，与本项目派生的系数分开存，
--    将来标准修订时改的是这张表。
--
-- 4. **各人群每天各类食物量**（portion_recommended_amounts）：成人平衡膳食宝塔 2022 +
--    学龄前 2–3 / 4–5 岁妇幼分会宝塔（OCR 未复核，note 里写明）。
--
--    **不录学龄儿童宝塔（6–10 / 11–13 / 14–17）**：它的年龄带与 WS/T 554 的分带
--    （6–8 / 9–11 / 12–14 / 15–17）不对齐，两套带并存会让「这个孩子吃多少」出现两个
--    互相打架的答案；总纲 §5 指定 WS/T 554 为折算系数与逐餐用量的唯一依据。
--
-- 5. **餐次占比**（portion_meal_shares）：WS/T 554—2017 §3.3 的早 25–30% / 午 35–40% / 晚 30–35%。
--    总纲 §5-2 要求「规则表存『全天量 × 餐次占比』」——全天量来自宝塔，占比来自标准，相乘才得到单餐量。
--    #22 留量上浮与 #23 买菜清单都要用它把「全天推荐量」落到「这一餐」。
--
-- 6. **附录 A 生熟 / 同类互换表**（exchange_groups / exchange_items）：食谱克数 ↔ 买菜克数。
--    本票只提供**查询与换算能力**，不做买菜清单（那是 #23）。
--
-- 预留：留量上浮系数（#22，默认 1.5×）本票不落表——上浮是家规（总纲 §5「不进规则表」），
-- 写在领域层常量里，等 #22 接家规配置时再挪。

-- ---------------------------------------------------------------- 折算系数

CREATE TABLE portion_adult_anchors (
  gender     TEXT PRIMARY KEY CHECK (gender IN ('male', 'female')),
  -- 轻活动成人全天能量（kcal）：折算系数的分母
  daily_kcal REAL NOT NULL CHECK (daily_kcal > 0),
  source     TEXT NOT NULL
);

CREATE TABLE portion_age_bands (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  -- 周岁区间的闭区间；max_age IS NULL = 成人档（不封顶）
  min_age     INTEGER NOT NULL CHECK (min_age >= 0),
  max_age     INTEGER CHECK (max_age IS NULL OR max_age >= min_age),
  -- 分性别带用 male/female；不分性别的档（学龄前 / 成人）用 any
  gender      TEXT NOT NULL CHECK (gender IN ('male', 'female', 'any')),
  -- 折算系数 = 儿童全天能量 ÷ 同性别成人锚点（派生列；权威量见下面两张表）
  coefficient REAL NOT NULL CHECK (coefficient > 0),
  -- 推导依据：wst554_energy（表 1 能量）| preschool_basket（学龄前宝塔推荐量篮比值）| adult_anchor（成人不折算）
  basis       TEXT NOT NULL CHECK (basis IN ('wst554_energy', 'preschool_basket', 'adult_anchor')),
  source      TEXT NOT NULL
);

CREATE TABLE portion_reference_energy (
  band_id    TEXT PRIMARY KEY REFERENCES portion_age_bands(id),
  daily_kcal REAL NOT NULL CHECK (daily_kcal > 0),
  source     TEXT NOT NULL
);

-- 餐次占比（总纲 §5-2，WS/T 554—2017 §3.3）：早 25–30% / 午 35–40% / 晚 30–35%。
-- 存「全天量 × 餐次占比」而不是直接存每餐克数：全天量来自宝塔，占比是标准给的，
-- 两者相乘才能得到某一餐的量——留量上浮（#22）与买菜清单（#23）都建立在「这一餐占全天多少」之上。
-- 早餐不进餐槽模型（总纲 §2.1），但占比照样存：它是标准原值，缺了会让「全天 → 单餐」的推导断链。
CREATE TABLE portion_meal_shares (
  meal      TEXT PRIMARY KEY CHECK (meal IN ('breakfast', 'lunch', 'dinner')),
  -- 展示顺序（0=早、1=午、2=晚）。**不是钟点**：餐次的钟点另有其表（家规里的餐次截止，
  -- #20 落库；领域层现有 MEAL_CUTOFF_HOUR）。两套值语义不同，混用会让「这一餐几点算过点」
  -- 与「这一餐排在第几」互相冒充——所以这里用序数而不是分钟数。
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  min_share  REAL NOT NULL CHECK (min_share > 0 AND min_share <= 1),
  max_share  REAL NOT NULL CHECK (max_share >= min_share AND max_share <= 1),
  source     TEXT NOT NULL
);

CREATE TABLE portion_recommended_amounts (
  -- 人群：成人 / 学龄前 2–3 岁 / 学龄前 4–5 岁（学龄儿童不录，理由见文件头）
  population       TEXT NOT NULL,
  population_label TEXT NOT NULL,
  group_key        TEXT NOT NULL,
  group_label      TEXT NOT NULL,
  -- 区间量：盐这类只看上限的，min_grams 为 NULL
  min_grams        REAL CHECK (min_grams IS NULL OR min_grams >= 0),
  max_grams        REAL NOT NULL CHECK (max_grams > 0),
  unit             TEXT NOT NULL DEFAULT 'g/天',
  note             TEXT,
  source           TEXT NOT NULL,
  PRIMARY KEY (population, group_key),
  CHECK (min_grams IS NULL OR min_grams <= max_grams)
);

-- ---------------------------------------------------------------- 生熟 / 同类互换（WS/T 554 附录 A）

CREATE TABLE exchange_groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- 互换基准：anchor_grams 的 anchor_name 等价于组内任意一条的 item.grams
  anchor_name  TEXT NOT NULL,
  anchor_grams REAL NOT NULL CHECK (anchor_grams > 0),
  source       TEXT NOT NULL
);

CREATE TABLE exchange_items (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES exchange_groups(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- 等价于 anchor_grams 的 anchor_name 的本品克数
  grams         REAL NOT NULL CHECK (grams > 0),
  -- 生重 / 熟重 / 市品重（含不可食部）——换算方向对不上就是把买少了，必须写清
  note          TEXT,
  -- 指向食材字典（能对上的条目，供 #23 买菜聚合复用；对不上的是市品口径差异，留空）
  ingredient_id TEXT REFERENCES ingredients(id),
  UNIQUE (group_id, name)
);

CREATE INDEX idx_exchange_items_group ON exchange_items (group_id);
CREATE INDEX idx_exchange_items_ingredient ON exchange_items (ingredient_id);

-- ---------------------------------------------------------------- 折算系数种子

-- 成人锚点（来源缺口见 findings open question 3：DRIs 2023 仅纸质书，无开放数据）
INSERT INTO portion_adult_anchors (gender, daily_kcal, source) VALUES
  ('male',   2250, 'DRIs 轻活动成年男通行取值（DRIs 2023 未开放，findings open question 3）；折算系数分母'),
  ('female', 1800, 'DRIs 轻活动成年女通行取值（DRIs 2023 未开放，findings open question 3）；折算系数分母');

-- 年龄分带（系数 = 儿童能量 ÷ 同性别成人锚点；6–17 岁为 WS/T 554—2017 表 1）
-- 2–5 岁：妇幼营养分会学龄前宝塔的推荐量篮比值（谷 + 蔬 + 畜禽鱼 的区间中值之和 ÷ 成人同口径 765 g）
--         2–3 岁：(100+150+62.5)/765 = 0.408；4–5 岁：(125+225+62.5)/765 = 0.539
INSERT INTO portion_age_bands (id, label, min_age, max_age, gender, coefficient, basis, source) VALUES
  ('preschool_2_3',    '2–3 岁',        2,  3, 'any',    0.408, 'preschool_basket',
   '中国学龄前儿童平衡膳食宝塔（妇幼营养分会，依据 2022 版指南绘制）推荐量篮比值；官方图 OCR，**未对照原图复核**（findings open question 2）'),
  ('preschool_4_5',    '4–5 岁',        4,  5, 'any',    0.539, 'preschool_basket',
   '中国学龄前儿童平衡膳食宝塔（妇幼营养分会，依据 2022 版指南绘制）推荐量篮比值；官方图 OCR，**未对照原图复核**（findings open question 2）'),
  ('child_6_8_male',   '6–8 岁男',      6,  8, 'male',   0.756, 'wst554_energy',
   'WS/T 554—2017 表 1：1700 kcal ÷ 成人男锚点 2250 kcal'),
  ('child_6_8_female', '6–8 岁女',      6,  8, 'female', 0.861, 'wst554_energy',
   'WS/T 554—2017 表 1：1550 kcal ÷ 成人女锚点 1800 kcal'),
  ('child_9_11_male',  '9–11 岁男',     9, 11, 'male',   0.933, 'wst554_energy',
   'WS/T 554—2017 表 1：2100 kcal ÷ 成人男锚点 2250 kcal'),
  ('child_9_11_female','9–11 岁女',     9, 11, 'female', 1.056, 'wst554_energy',
   'WS/T 554—2017 表 1：1900 kcal ÷ 成人女锚点 1800 kcal'),
  ('child_12_14_male', '12–14 岁男',   12, 14, 'male',   1.089, 'wst554_energy',
   'WS/T 554—2017 表 1：2450 kcal ÷ 成人男锚点 2250 kcal'),
  ('child_12_14_female','12–14 岁女',  12, 14, 'female', 1.167, 'wst554_energy',
   'WS/T 554—2017 表 1：2100 kcal ÷ 成人女锚点 1800 kcal'),
  ('child_15_17_male', '15–17 岁男',   15, 17, 'male',   1.289, 'wst554_energy',
   'WS/T 554—2017 表 1：2900 kcal ÷ 成人男锚点 2250 kcal'),
  ('child_15_17_female','15–17 岁女',  15, 17, 'female', 1.306, 'wst554_energy',
   'WS/T 554—2017 表 1：2350 kcal ÷ 成人女锚点 1800 kcal'),
  ('adult',            '成人',         18, NULL, 'any',   1.000, 'adult_anchor',
   '成人按菜谱成人份基准，不折算（总纲 §2.9）');

INSERT INTO portion_reference_energy (band_id, daily_kcal, source) VALUES
  ('child_6_8_male',    1700, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）'),
  ('child_6_8_female',  1550, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）'),
  ('child_9_11_male',   2100, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）'),
  ('child_9_11_female', 1900, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）'),
  ('child_12_14_male',  2450, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）'),
  ('child_12_14_female',2100, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）'),
  ('child_15_17_male',  2900, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）'),
  ('child_15_17_female',2350, 'WS/T 554—2017 表 1 每人每天能量供给量（允许 90%–110% 浮动）');

-- 每天各类食物量：成人 = 平衡膳食宝塔 2022；学龄前 = 妇幼分会宝塔（OCR 未复核）
INSERT INTO portion_recommended_amounts
  (population, population_label, group_key, group_label, min_grams, max_grams, note, source) VALUES
  ('adult', '成人（1600–2400 kcal）', 'grain',     '谷类',         200, 300, '其中全谷物和杂豆 50–150', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'tuber',     '薯类',          50, 100, '能量上相当于 15–35 g 大米', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'vegetable', '蔬菜',         300, 500, '深色蔬菜 ≥1/2', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'fruit',     '水果',         200, 350, NULL, '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'meat',      '畜禽肉',        40,  75, '每周至少 2 次水产', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'aquatic',   '水产品',        40,  75, NULL, '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'egg',       '蛋类',          50,  50, '每天 1 个鸡蛋', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'dairy',     '奶及奶制品',   300, 500, '鲜奶当量', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'soy_nuts',  '大豆及坚果',    25,  35, '其中坚果约 10（每周约 70）', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'oil',       '烹调油',        25,  30, NULL, '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('adult', '成人（1600–2400 kcal）', 'salt',      '盐',          NULL,   5, '上限', '中国居民平衡膳食宝塔（2022）五层数值（dg.cnsoc.org 官方解析文章）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'grain',     '谷类',          75, 125, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'vegetable', '蔬菜',         100, 200, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'fruit',     '水果',         100, 200, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'animal',    '畜禽肉鱼类',    50,  75, '畜禽肉与水产品合并给量', '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'egg',       '蛋类',          50,  50, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'dairy',     '奶类',         350, 500, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'soy',       '大豆',           5,  15, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'oil',       '油',            10,  20, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_2_3', '学龄前 2–3 岁', 'salt',      '盐',          NULL,   2, '上限', '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'grain',     '谷类',         100, 150, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'vegetable', '蔬菜',         150, 300, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'fruit',     '水果',         150, 250, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'animal',    '畜禽肉鱼类',    50,  75, '畜禽肉与水产品合并给量', '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'egg',       '蛋类',          50,  50, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'dairy',     '奶类',         350, 500, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'soy',       '大豆',          15,  20, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'oil',       '油',            20,  25, NULL, '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）'),
  ('preschool_4_5', '学龄前 4–5 岁', 'salt',      '盐',          NULL,   3, '上限', '中国学龄前儿童平衡膳食宝塔（妇幼营养分会）官方图 OCR，**未复核**（findings open question 2）');

-- ---------------------------------------------------------------- 生熟 / 同类互换种子（WS/T 554—2017 附录 A）

INSERT INTO portion_meal_shares (meal, sort_order, min_share, max_share, source) VALUES
  ('breakfast', 0, 0.25, 0.30, 'WS/T 554—2017 §3.3：早 25–30% / 午 35–40% / 晚 30–35%（总纲 §5-2）'),
  ('lunch',     1, 0.35, 0.40, 'WS/T 554—2017 §3.3：早 25–30% / 午 35–40% / 晚 30–35%（总纲 §5-2）'),
  ('dinner',    2, 0.30, 0.35, 'WS/T 554—2017 §3.3：早 25–30% / 午 35–40% / 晚 30–35%（总纲 §5-2）');

INSERT INTO exchange_groups (id, name, anchor_name, anchor_grams, source) VALUES
  ('staple',    '主食（生重 ↔ 熟食 ↔ 同类）', '大米（生）',       50, 'WS/T 554—2017 附录 A（资料性）生熟/同类互换表'),
  ('vegetable', '蔬菜（可食部 ↔ 市品重）',     '蔬菜（可食部）',  100, 'WS/T 554—2017 附录 A（资料性）生熟/同类互换表'),
  ('fruit',     '水果（可食部 ↔ 市品重）',     '水果（可食部）',  100, 'WS/T 554—2017 附录 A（资料性）生熟/同类互换表'),
  ('fish',      '鱼肉（生重 ↔ 市品重）',       '鱼肉',             50, 'WS/T 554—2017 附录 A（资料性）生熟/同类互换表'),
  ('meat',      '肉（瘦肉 ↔ 同类）',           '瘦猪肉',           50, 'WS/T 554—2017 附录 A（资料性）生熟/同类互换表'),
  ('soy',       '大豆（干重 ↔ 豆制品）',       '干黄豆',           50, 'WS/T 554—2017 附录 A（资料性）生熟/同类互换表'),
  ('dairy',     '奶（鲜奶 ↔ 奶制品）',         '鲜奶',            100, 'WS/T 554—2017 附录 A（资料性）生熟/同类互换表');

-- 组内每一条的语义相同：「grams 的本品 = anchor_grams 的 anchor_name」。
-- 两条之间的换算 = 目标克数 × 目标 item.grams ÷ 源 item.grams（domain/portion.ts 的 convertExchange）。
INSERT INTO exchange_items (id, group_id, name, grams, note, ingredient_id) VALUES
  -- 50 g 大米/面粉 ≈ 米饭（粳米 110、籼米 150）≈ 馒头/花卷 80 ≈ 面条（挂面 50、切面 60）≈ 烙饼 70 ≈ 面包 55 ≈ 红薯（生）190 ≈ 米粥 375
  ('staple_rice_raw',       'staple', '大米',           50, '生重', 'rice'),
  ('staple_flour',          'staple', '面粉',           50, '生重', 'flour'),
  ('staple_rice_japonica',  'staple', '米饭（粳米）',  110, '熟重', NULL),
  ('staple_rice_indica',    'staple', '米饭（籼米）',  150, '熟重', NULL),
  ('staple_steamed_bun',    'staple', '馒头 / 花卷',    80, '熟重', NULL),
  ('staple_dried_noodles',  'staple', '挂面',           50, '干重', NULL),
  ('staple_fresh_noodles',  'staple', '切面',           60, '湿重', NULL),
  ('staple_pancake',        'staple', '烙饼',           70, '熟重', NULL),
  ('staple_bread',          'staple', '面包',           55, '市品重', NULL),
  ('staple_sweet_potato',   'staple', '红薯',          190, '生重', NULL),
  -- 米粥由大米熬成，但买的是大米：这里不挂 ingredient_id——挂了就等于把「375 g 米粥」
  -- 当成「375 g 大米」并进买菜聚合（#23 要的是经本表换算回生重，不是直接相加）
  ('staple_rice_porridge',  'staple', '米粥',          375, '熟重（由大米折算）', NULL),
  -- 蔬菜按「可食部 100 g」对应市品重：黄瓜 110、番茄 100、大白菜 115、芹菜 150、莴笋 160、冬瓜 125
  ('vegetable_cucumber',    'vegetable', '黄瓜',       110, '市品重（含不可食部）', 'cucumber'),
  ('vegetable_tomato',      'vegetable', '番茄',       100, '市品重（含不可食部）', 'tomato'),
  ('vegetable_chinese_cabbage', 'vegetable', '大白菜', 115, '市品重（含不可食部）', 'chinese_cabbage'),
  ('vegetable_celery',      'vegetable', '芹菜',       150, '市品重（含不可食部）', 'celery'),
  ('vegetable_celtuce',     'vegetable', '莴笋',       160, '市品重（含不可食部）', NULL),
  ('vegetable_winter_melon', 'vegetable', '冬瓜',      125, '市品重（含不可食部）', 'winter_melon'),
  -- 水果：苹果 130、柑橘 130、香蕉 170、西瓜 180（同为可食部 100 g 对应的市品重）
  ('fruit_apple',           'fruit', '苹果',           130, '市品重（含不可食部）', NULL),
  ('fruit_citrus',          'fruit', '柑橘',           130, '市品重（含不可食部）', NULL),
  ('fruit_banana',          'fruit', '香蕉',           170, '市品重（含不可食部）', NULL),
  ('fruit_watermelon',      'fruit', '西瓜',           180, '市品重（含不可食部）', NULL),
  -- 50 g 鱼肉 ≈ 草鱼 85、带鱼 65、鲤鱼 90、虾 80、蛤蜊 130
  ('fish_grass_carp',       'fish', '草鱼',             85, '市品重（含骨刺）', 'grass_carp'),
  ('fish_hairtail',         'fish', '带鱼',             65, '市品重（含骨刺）', 'hairtail'),
  ('fish_carp',             'fish', '鲤鱼',             90, '市品重（含骨刺）', NULL),
  ('fish_shrimp',           'fish', '虾',               80, '市品重', 'shrimp'),
  ('fish_clam',             'fish', '蛤蜊',            130, '市品重（带壳）', 'shellfish'),
  -- 50 g 瘦猪肉 ≈ 整鸡鸭鹅 50、瘦牛羊肉 50、鸡胸 40、猪排骨 85、酱牛肉 35
  ('meat_pork_lean',        'meat', '瘦猪肉',           50, '生重', NULL),
  ('meat_poultry_whole',    'meat', '整鸡 / 鸭 / 鹅',   50, '生重（带骨）', 'whole_chicken'),
  ('meat_beef_lamb_lean',   'meat', '瘦牛肉 / 羊肉',    50, '生重', 'beef'),
  ('meat_chicken_breast',   'meat', '鸡胸肉',           40, '生重', NULL),
  ('meat_pork_ribs',        'meat', '猪排骨',           85, '生重（带骨）', 'pork_ribs'),
  ('meat_braised_beef',     'meat', '酱牛肉',           35, '熟重', NULL),
  -- 50 g 干黄豆 ≈ 北豆腐 145、南豆腐 280、内酯豆腐 350、豆腐干 110、豆浆 730、腐竹 35
  ('soy_dried_soybean',     'soy', '干黄豆',             50, '干重', NULL),
  ('soy_north_tofu',        'soy', '北豆腐',            145, '市品重', 'tofu'),
  ('soy_south_tofu',        'soy', '南豆腐',            280, '市品重', 'tofu'),
  ('soy_silken_tofu',       'soy', '内酯豆腐',          350, '市品重', 'tofu'),
  ('soy_dried_tofu',        'soy', '豆腐干',            110, '市品重', 'dried_tofu'),
  ('soy_soy_milk',          'soy', '豆浆',              730, '市品重', NULL),
  ('soy_tofu_skin',         'soy', '腐竹',               35, '干重', NULL),
  -- 100 g 鲜奶 ≈ 奶粉 15、酸奶 100、奶酪 10
  ('dairy_milk',            'dairy', '鲜奶',            100, '市品重', NULL),
  ('dairy_milk_powder',     'dairy', '奶粉',             15, '干重', NULL),
  ('dairy_yogurt',          'dairy', '酸奶',            100, '市品重', NULL),
  ('dairy_cheese',          'dairy', '奶酪',             10, '市品重', NULL);
