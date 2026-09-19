-- M1-03 家庭菜谱库、餐槽手动定餐与留痕事件流（总纲 §2.8、§3；ADR-0007）
--
-- 本票落三块：
--
-- 1. **菜谱（总纲 §2.8 精简核心集）**：身份（名 + 别名）、荤素类型（荤/素/汤，汤分荤素）、
--    每项食材的成人份生重基准 + 可缩放规则 + 生熟换算锚点、口味封闭五标签、适季月份、
--    难度三档、状态机（草稿→转正→退役）、来源。忌口关联不落列：它由食材清单 ∪ 隐性忌口
--    「含」指针推出（domain/recipes.ts 现算），落列就要随食材/指针变化同步维护，那正是会漂移的地方。
--    做法步骤是自由文本，只给掌勺者参考，不进推荐管线。
--
-- 2. **食材字典扩充**：时令月份（ingredient_season_months）+ 隐性忌口「含」指针
--    （ingredient_contains，自引用：蚝油含贝类、豆瓣酱含辣椒）。001 的注释里说了这两块
--    是 #15 的加表活，本票如约补上，不改 001 已有的两列形状。
--
--    同时重建 member_loves：001 里 recipe_id 只是可空列（菜谱表还不存在），现在菜谱表有了，
--    按 001 注释留下的话补外键——SQLite 加外键要重建表，所以整表重建、原有种子行照抄。
--
-- 3. **餐槽与留痕（ADR-0007）**：**没有可变的餐槽/菜单表**。餐桌的历史就是发生过的事件的
--    累积，当前状态由事件流折叠得出；「最近吃过」也直接查事件流。菜单每次变化（预定/改餐/取消）
--    追加一条 meal_events，用餐者名单与菜品是事件的两个子表（事件不可变 → 快照随事件一起固化）。
--    取消事件不带用餐者与菜品。
--
-- 预留：留量「吃剩的」引用与上浮（#22）、LLM 调用元数据的落值（#17）先只留字段/占位，
-- 本票不实现它们的逻辑。

-- ---------------------------------------------------------------- 菜谱

CREATE TABLE recipes (
  id     TEXT PRIMARY KEY,
  -- 菜名全库唯一：家人叫法进 recipe_aliases，规范名只有一条
  name   TEXT NOT NULL UNIQUE,
  -- 荤 / 素 / 汤（汤分荤素）——汤分两类是因为忌口与结构位判定都要按「荤汤/素汤」区分
  kind   TEXT NOT NULL CHECK (kind IN ('meat', 'veg', 'soup_meat', 'soup_veg')),
  -- 难度耗时三档：快手(<20min) / 中等 / 费事
  effort TEXT NOT NULL CHECK (effort IN ('quick', 'medium', 'heavy')),
  -- 状态机：草稿 → 转正（active）→ 退役（退役不进推荐，行保留）
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  -- 来源：口述 / HowToCook / 下厨房爬取 / LLM 生成
  source TEXT NOT NULL CHECK (source IN ('oral', 'howtocook', 'scraped', 'llm')),
  -- 做法步骤自由文本，掌勺者参考用，**不进推荐管线**
  steps  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_recipes_status ON recipes (status);

-- 别名全局唯一：一个叫法只能指向一道菜（与食材别名同口径）
CREATE TABLE recipe_aliases (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL PRIMARY KEY
);

CREATE INDEX idx_recipe_aliases_recipe ON recipe_aliases (recipe_id);

-- 口味封闭五标签（多选）：值域写死在 CHECK 里——「封闭」的意思就是这张表只认这五个
CREATE TABLE recipe_tastes (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  taste     TEXT NOT NULL CHECK (taste IN ('甜', '辣', '酸', '咸鲜', '清淡')),
  PRIMARY KEY (recipe_id, taste)
);

-- 适季月份 1–12；一道菜一行都没有 = 四季皆宜（不写全 12 行，那是 12 条噪音）
CREATE TABLE recipe_season_months (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  month     INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  PRIMARY KEY (recipe_id, month)
);

-- 菜谱食材项：成人份生重基准 + 可缩放规则 + 生熟换算锚点
CREATE TABLE recipe_ingredients (
  recipe_id    TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  -- 字典是全库唯一受控表：菜谱食材指向不存在的食材必须失败（RESTRICT，不用 CASCADE）
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  position     INTEGER NOT NULL,
  -- 成人份生重克数基准（一个成人一餐这道菜的量）
  adult_grams  REAL NOT NULL CHECK (adult_grams > 0),
  -- 可缩放规则：linear 随用餐者份数缩放；fixed 不随人数放大（如虫草花 5g，一锅就这么多）
  scaling      TEXT NOT NULL DEFAULT 'linear' CHECK (scaling IN ('linear', 'fixed')),
  -- 生熟换算锚点（WS/T 554 附录 A 的引用，如「大米 100g ≈ 米饭 220g」）；调料等无需换算的为 NULL
  raw_cooked_anchor TEXT,
  PRIMARY KEY (recipe_id, ingredient_id),
  UNIQUE (recipe_id, position)
);

CREATE INDEX idx_recipe_ingredients_ingredient ON recipe_ingredients (ingredient_id);

-- ---------------------------------------------------------------- 食材字典扩充

-- 时令月份 1–12；一个食材一行都没有 = 未录 / 四季有售
CREATE TABLE ingredient_season_months (
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  PRIMARY KEY (ingredient_id, month)
);

-- 隐性忌口「含」指针（总纲 §2.9）：食材清单里看不见、但复合调料里含有的忌口（蚝油含贝类）。
-- 自引用：目标必须是字典里的另一个食材；递归展开（含的含）由领域层做，表里只存直接指针。
CREATE TABLE ingredient_contains (
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  contains_id   TEXT NOT NULL REFERENCES ingredients(id),
  PRIMARY KEY (ingredient_id, contains_id),
  CHECK (ingredient_id <> contains_id)
);

CREATE INDEX idx_ingredient_contains_target ON ingredient_contains (contains_id);

-- member_loves 重建：001 里 recipe_id 是无外键的可空列（菜谱表当时不存在），
-- 现在补 REFERENCES recipes(id)。SQLite 不能 ALTER 加外键，只能整表重建。
CREATE TABLE member_loves_new (
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ingredient_id TEXT REFERENCES ingredients(id),
  recipe_id     TEXT REFERENCES recipes(id),
  created_at    TEXT NOT NULL,
  CHECK ((ingredient_id IS NOT NULL) + (recipe_id IS NOT NULL) = 1)
);

INSERT INTO member_loves_new (member_id, ingredient_id, recipe_id, created_at)
  SELECT member_id, ingredient_id, recipe_id, created_at FROM member_loves;

DROP TABLE member_loves;
ALTER TABLE member_loves_new RENAME TO member_loves;

CREATE INDEX idx_member_loves_member ON member_loves (member_id);
CREATE UNIQUE INDEX idx_member_loves_ingredient
  ON member_loves (member_id, ingredient_id) WHERE ingredient_id IS NOT NULL;
CREATE UNIQUE INDEX idx_member_loves_recipe
  ON member_loves (member_id, recipe_id) WHERE recipe_id IS NOT NULL;

-- ---------------------------------------------------------------- 留痕事件流（ADR-0007）

-- append-only：只有 INSERT，没有 UPDATE/DELETE。seq 自增即事件发生顺序。
CREATE TABLE meal_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'YYYY-MM-DD:lunch|dinner'（家庭时区的日历日期 × 餐次）
  slot_id     TEXT NOT NULL,
  slot_date   TEXT NOT NULL,
  meal        TEXT NOT NULL CHECK (meal IN ('lunch', 'dinner')),
  -- 预定（含首次改餐后的每次改餐）→ decide/replace；取消 → cancel
  -- 预定 → decide；改餐 → replace单道 / replace_set整套（§3 决议 3：换单道、换一整套各记一条）；取消 → cancel
  type        TEXT NOT NULL CHECK (type IN ('decide', 'replace', 'replace_set', 'cancel')),
  -- 定餐来源：手动挑菜 / 接受整餐推荐（#17 落值）
  source      TEXT NOT NULL CHECK (source IN ('manual', 'recommendation')),
  occurred_at TEXT NOT NULL,
  -- LLM 调用元数据（#17 落值；模板进代码库 git 管版本）
  llm_model          TEXT,
  llm_prompt_version TEXT,
  llm_latency_ms     INTEGER,
  llm_degraded       INTEGER CHECK (llm_degraded IS NULL OR llm_degraded IN (0, 1)),
  -- 留量「吃剩的」引用（#22 落值：引用哪一餐）
  leftover_menu_slot_id TEXT,
  -- 三件套要么都空（手动定餐），要么都齐（LLM 参与过）——半份元数据没法解释
  CHECK ((llm_model IS NULL) = (llm_prompt_version IS NULL)
     AND (llm_model IS NULL) = (llm_latency_ms IS NULL)
     AND (llm_model IS NULL) = (llm_degraded IS NULL))
);

CREATE INDEX idx_meal_events_slot ON meal_events (slot_id, seq);
CREATE INDEX idx_meal_events_date ON meal_events (slot_date, meal);

-- 用餐者名单**快照**（总纲 §3）：存当时的姓名与头像，家人后来改名/删号也不改写历史。
-- 不带 ON DELETE CASCADE：下一步的 append-only 触发器让主表根本删不掉，级联是永远走不到的死代码。
CREATE TABLE meal_event_diners (
  seq         INTEGER NOT NULL REFERENCES meal_events(seq),
  position    INTEGER NOT NULL,
  member_id   TEXT NOT NULL,
  member_name TEXT NOT NULL,
  member_emoji TEXT NOT NULL,
  PRIMARY KEY (seq, position)
);

-- 菜品快照：指向菜谱（菜谱行不删，退役也保留——历史要能查；且被历史引用过的菜谱删不掉）
CREATE TABLE meal_event_dishes (
  seq           INTEGER NOT NULL REFERENCES meal_events(seq),
  position      INTEGER NOT NULL,
  recipe_id     TEXT NOT NULL REFERENCES recipes(id),
  -- 多做留到下顿（总纲 §2.6）
  keep_leftover INTEGER NOT NULL DEFAULT 0 CHECK (keep_leftover IN (0, 1)),
  PRIMARY KEY (seq, position)
);

CREATE INDEX idx_meal_event_dishes_recipe ON meal_event_dishes (recipe_id);

-- append-only 不是口头约定：触发器等于是数据库替我们看门（ADR-0007）。
-- 留痕一旦可被改写，「为什么推这道 / 为什么没推」的回溯就失效了。
-- 两处都是 RAISE(ABORT)，不是先删后报——半截的改写比拒绝危险。
CREATE TRIGGER meal_events_no_update BEFORE UPDATE ON meal_events
BEGIN
  SELECT RAISE(ABORT, 'meal_events 是 append-only：事件不可改写');
END;

CREATE TRIGGER meal_events_no_delete BEFORE DELETE ON meal_events
BEGIN
  SELECT RAISE(ABORT, 'meal_events 是 append-only：事件不可删除');
END;

-- 子表同样只管追加（主表删不掉，子表也只能跟着加）
CREATE TRIGGER meal_event_diners_no_update BEFORE UPDATE ON meal_event_diners
BEGIN
  SELECT RAISE(ABORT, 'meal_event_diners 是 append-only：事件快照不可改写');
END;

CREATE TRIGGER meal_event_diners_no_delete BEFORE DELETE ON meal_event_diners
BEGIN
  SELECT RAISE(ABORT, 'meal_event_diners 是 append-only：事件快照不可删除');
END;

CREATE TRIGGER meal_event_dishes_no_update BEFORE UPDATE ON meal_event_dishes
BEGIN
  SELECT RAISE(ABORT, 'meal_event_dishes 是 append-only：事件快照不可改写');
END;

CREATE TRIGGER meal_event_dishes_no_delete BEFORE DELETE ON meal_event_dishes
BEGIN
  SELECT RAISE(ABORT, 'meal_event_dishes 是 append-only：事件快照不可删除');
END;

-- ---------------------------------------------------------------- 食材字典扩充种子

-- 家常时令（按自家菜场实情录入；未列的食材四季有售，不写）
INSERT INTO ingredient_season_months (ingredient_id, month) VALUES
  ('tomato',          6), ('tomato',          7), ('tomato',          8), ('tomato',          9),
  ('cucumber',        6), ('cucumber',        7), ('cucumber',        8),
  ('chinese_cabbage',11), ('chinese_cabbage',12), ('chinese_cabbage', 1), ('chinese_cabbage', 2),
  ('baby_cabbage',   11), ('baby_cabbage',   12), ('baby_cabbage',    1), ('baby_cabbage',    2),
  ('choy_sum',       11), ('choy_sum',       12), ('choy_sum',        1), ('choy_sum',        2),
  ('bok_choy',       11), ('bok_choy',       12), ('bok_choy',        1), ('bok_choy',        2),
  ('spinach',        11), ('spinach',        12), ('spinach',         1), ('spinach',         2), ('spinach',         3),
  ('broccoli',       11), ('broccoli',       12), ('broccoli',        1), ('broccoli',        2),
  ('carrot',         10), ('carrot',         11), ('carrot',         12), ('carrot',          1),
  ('white_radish',   10), ('white_radish',   11), ('white_radish',   12), ('white_radish',    1), ('white_radish',    2),
  ('winter_melon',    6), ('winter_melon',    7), ('winter_melon',    8), ('winter_melon',    9),
  ('pumpkin',         8), ('pumpkin',         9), ('pumpkin',        10),
  ('eggplant',        6), ('eggplant',        7), ('eggplant',        8), ('eggplant',        9),
  ('green_pepper',    6), ('green_pepper',    7), ('green_pepper',    8), ('green_pepper',    9),
  ('chives',          3), ('chives',          4), ('chives',          5), ('chives',          6),
  ('bitter_melon',    6), ('bitter_melon',    7), ('bitter_melon',    8), ('bitter_melon',    9),
  ('corn',            6), ('corn',            7), ('corn',            8), ('corn',            9),
  ('long_beans',      6), ('long_beans',      7), ('long_beans',      8), ('long_beans',      9),
  ('lotus_root',      9), ('lotus_root',     10), ('lotus_root',     11), ('lotus_root',     12), ('lotus_root',      1),
  ('chinese_yam',    10), ('chinese_yam',    11), ('chinese_yam',    12), ('chinese_yam',     1),
  ('celery',         11), ('celery',         12), ('celery',          1), ('celery',          2), ('celery',          3),
  ('loofah',          6), ('loofah',          7), ('loofah',          8), ('loofah',          9),
  ('shiitake',       11), ('shiitake',       12), ('shiitake',        1), ('shiitake',        2),
  ('enoki',          11), ('enoki',          12), ('enoki',           1), ('enoki',           2);

-- 隐性忌口「含」指针：食材清单里看不见的忌口
INSERT INTO ingredient_contains (ingredient_id, contains_id) VALUES
  -- 蚝油是牡蛎熬的：小宝忌贝类 → 用蚝油的菜整体排除
  ('oyster_sauce', 'shellfish'),
  -- 郫县豆瓣含辣椒：大宝忌辣 → 麻婆豆腐整体排除
  ('doubanjiang',  'chili');

-- 补两味 001 没列、家常菜谱用得上的食材（虫草花蒸鸡）
INSERT INTO ingredients (id, name) VALUES ('cordyceps_flower', '虫草花');
INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ('cordyceps_flower', '蛹虫草');

-- ---------------------------------------------------------------- 家庭菜谱库种子

-- 原型 main-ui 的 RECIPES（家庭常做菜，口述整理、已转正）+ 两道刻意留出的状态样本：
-- 一道草稿（HowToCook 导入、家里还没做过）与一道退役（爬取来的，家里不做了）。
-- 生重基准是原型里的成人份示意值；调料项给的是「一道菜一锅」的量（fixed）。
INSERT INTO recipes (id, name, kind, effort, status, source, steps) VALUES
  ('hongshaopaigu',     '红烧排骨',        'meat',      'medium', 'active',  'oral',      '排骨焯水，炒糖色，加生抽老抽料酒，小火焖 40 分钟收汁。'),
  ('kelejichi',         '可乐鸡翅',        'meat',      'medium', 'active',  'oral',      '鸡翅两面煎黄，倒可乐没过，加生抽姜片，中火收汁。'),
  ('qingzhengluyu',     '清蒸鲈鱼',        'meat',      'medium', 'active',  'oral',      '鲈鱼改刀铺姜丝，水开蒸 8 分钟，淋蒸鱼豉油、泼热油。'),
  ('tudouniuniu',       '土豆炖牛腩',      'meat',      'heavy',  'active',  'oral',      '牛腩焯水炒香，加水炖 1 小时，下土豆块再炖 20 分钟。'),
  ('tangculiji',        '糖醋里脊',        'meat',      'medium', 'active',  'oral',      '里脊切条挂糊炸两遍，番茄酱白糖白醋调汁翻匀。'),
  ('chongcaohuazhengji','虫草花蒸鸡',      'meat',      'medium', 'active',  'oral',      '鸡腿斩块用虫草花、姜片、料酒腌 20 分钟，蒸 25 分钟。'),
  ('baizhuoxia',        '白灼虾',          'meat',      'quick',  'active',  'oral',      '水开下虾煮 2 分钟，捞出蘸姜醋汁。'),
  ('huangmenji',        '黄焖鸡',          'meat',      'medium', 'active',  'oral',      '鸡腿块炒香，加青椒土豆与生抽，加水焖 20 分钟。'),
  ('fanqiechaodan',     '番茄炒蛋',        'veg',       'quick',  'active',  'oral',      '鸡蛋炒散盛出，番茄炒出汁，回锅加盐翻匀。'),
  ('suanrongcaixin',    '蒜蓉菜心',        'veg',       'quick',  'active',  'oral',      '菜心焯水，蒜蓉爆香后大火快炒，加盐出锅。'),
  ('culutudousi',       '醋溜土豆丝',      'veg',       'quick',  'active',  'oral',      '土豆切丝泡水，大火快炒，出锅前沿锅边淋醋。'),
  ('shangtangwawacai',  '上汤娃娃菜',      'veg',       'quick',  'active',  'oral',      '娃娃菜切条，蒜片爆香加高汤煮 3 分钟。'),
  ('mapodoufu',         '麻婆豆腐',        'veg',       'medium', 'active',  'oral',      '肉末炒散，下豆瓣酱炒出红油，加豆腐与水煮 5 分钟，勾芡。'),
  ('danchaofan',        '蛋炒饭',          'veg',       'quick',  'active',  'oral',      '鸡蛋炒散，下米饭炒散，加葱花与盐翻匀。'),
  ('haoyoushengcai',    '蚝油生菜',        'veg',       'quick',  'active',  'oral',      '生菜焯水摆盘，蚝油加少许糖水烧开淋上。'),
  ('dongguapaigutang',  '冬瓜排骨汤',      'soup_meat', 'medium', 'active',  'oral',      '排骨焯水，加姜片炖 40 分钟，下冬瓜再炖 15 分钟。'),
  ('yumihuluobogutang', '玉米胡萝卜排骨汤', 'soup_meat','heavy',  'active',  'oral',      '排骨焯水，与玉米段、胡萝卜块同炖 1 小时。'),
  ('fanqiedanhuatang',  '番茄蛋花汤',      'soup_veg',  'quick',  'active',  'oral',      '番茄炒软加水烧开，淋蛋液，加盐与香油。'),
  ('xiangguhuaji',      '香菇滑鸡',        'meat',      'medium', 'draft',   'howtocook', '鸡腿块用生抽淀粉腌 15 分钟，与香菇同蒸 20 分钟。'),
  ('xiangjiandaiyu',    '香煎带鱼',        'meat',      'quick',  'retired', 'scraped',   '带鱼段擦干拍薄粉，中小火两面煎金黄，撒盐。');

INSERT INTO recipe_aliases (recipe_id, alias) VALUES
  ('hongshaopaigu',     '排骨'),
  ('kelejichi',         '可乐翅'),
  ('qingzhengluyu',     '清蒸鱼'),
  ('huangmenji',        '黄焖鸡米饭'),
  ('fanqiechaodan',     '西红柿炒鸡蛋'),
  ('danchaofan',        '炒饭'),
  ('fanqiedanhuatang',  '番茄蛋汤'),
  ('yumihuluobogutang', '排骨玉米汤');

INSERT INTO recipe_tastes (recipe_id, taste) VALUES
  ('hongshaopaigu',     '咸鲜'),
  ('kelejichi',         '甜'),   ('kelejichi',         '咸鲜'),
  ('qingzhengluyu',     '清淡'), ('qingzhengluyu',     '咸鲜'),
  ('tudouniuniu',       '咸鲜'),
  ('tangculiji',        '甜'),   ('tangculiji',        '酸'),
  ('chongcaohuazhengji','清淡'),
  ('baizhuoxia',        '清淡'),
  ('huangmenji',        '辣'),   ('huangmenji',        '咸鲜'),
  ('fanqiechaodan',     '咸鲜'),
  ('suanrongcaixin',    '清淡'),
  ('culutudousi',       '酸'),   ('culutudousi',       '咸鲜'),
  ('shangtangwawacai',  '清淡'),
  ('mapodoufu',         '辣'),   ('mapodoufu',         '咸鲜'),
  ('danchaofan',        '咸鲜'),
  ('haoyoushengcai',    '咸鲜'),
  ('dongguapaigutang',  '清淡'),
  ('yumihuluobogutang', '清淡'),
  ('fanqiedanhuatang',  '清淡'), ('fanqiedanhuatang',  '酸'),
  ('xiangguhuaji',      '咸鲜'),
  ('xiangjiandaiyu',    '咸鲜');

-- 只给真按季节做的几道写适季月份；其余不写 = 四季皆宜
INSERT INTO recipe_season_months (recipe_id, month) VALUES
  ('baizhuoxia',       5), ('baizhuoxia',       6), ('baizhuoxia',       7), ('baizhuoxia',       8), ('baizhuoxia',       9), ('baizhuoxia',      10),
  ('dongguapaigutang', 6), ('dongguapaigutang', 7), ('dongguapaigutang', 8), ('dongguapaigutang', 9),
  ('suanrongcaixin',  12), ('suanrongcaixin',   1), ('suanrongcaixin',   2),
  ('shangtangwawacai',11), ('shangtangwawacai',12), ('shangtangwawacai', 1), ('shangtangwawacai', 2);

INSERT INTO recipe_ingredients (recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor) VALUES
  ('hongshaopaigu',     'pork_ribs',       0, 150, 'linear', NULL),
  ('kelejichi',         'chicken_wings',   0, 130, 'linear', NULL),
  ('kelejichi',         'cooking_oil',     1,  10, 'fixed',  NULL),
  ('qingzhengluyu',     'seabass',         0, 160, 'linear', NULL),
  ('qingzhengluyu',     'light_soy_sauce', 1,  10, 'fixed',  NULL),
  ('tudouniuniu',       'beef_brisket',    0, 110, 'linear', NULL),
  ('tudouniuniu',       'potato',          1, 110, 'linear', NULL),
  ('tangculiji',        'pork_tenderloin', 0, 130, 'linear', NULL),
  ('tangculiji',        'tomato_paste',    1,  20, 'fixed',  NULL),
  ('chongcaohuazhengji','chicken_legs',    0, 140, 'linear', NULL),
  -- 虫草花一锅就放 5g：fixed —— 人数翻倍也不是 10g（可缩放规则的意义）
  ('chongcaohuazhengji','cordyceps_flower',1,   5, 'fixed',  NULL),
  ('baizhuoxia',        'shrimp',          0, 150, 'linear', NULL),
  ('huangmenji',        'chicken_legs',    0, 140, 'linear', NULL),
  ('huangmenji',        'potato',          1,  80, 'linear', NULL),
  ('huangmenji',        'green_pepper',    2,  30, 'linear', NULL),
  ('fanqiechaodan',     'tomato',          0, 120, 'linear', NULL),
  ('fanqiechaodan',     'egg',             1,  60, 'linear', '鸡蛋 60g ≈ 炒蛋 55g（WS/T 554 附录 A）'),
  ('suanrongcaixin',    'choy_sum',        0, 150, 'linear', NULL),
  ('suanrongcaixin',    'garlic',          1,  10, 'fixed',  NULL),
  ('culutudousi',       'potato',          0, 150, 'linear', NULL),
  ('culutudousi',       'vinegar',         1,   8, 'fixed',  NULL),
  ('shangtangwawacai',  'baby_cabbage',    0, 150, 'linear', NULL),
  ('shangtangwawacai',  'garlic',          1,   5, 'fixed',  NULL),
  ('mapodoufu',         'tofu',            0, 180, 'linear', NULL),
  ('mapodoufu',         'pork_mince',      1,  40, 'linear', NULL),
  ('mapodoufu',         'doubanjiang',     2,  15, 'fixed',  NULL),
  -- 生熟换算锚点：大米 100g ≈ 米饭 220g（WS/T 554 附录 A），蛋炒饭的米量写作生重
  ('danchaofan',        'rice',            0, 100, 'linear', '大米 100g ≈ 米饭 220g（WS/T 554 附录 A）'),
  ('danchaofan',        'egg',             1,  60, 'linear', NULL),
  ('danchaofan',        'scallion',        2,   5, 'fixed',  NULL),
  ('haoyoushengcai',    'lettuce',         0, 150, 'linear', NULL),
  ('haoyoushengcai',    'oyster_sauce',    1,  10, 'fixed',  NULL),
  ('dongguapaigutang',  'pork_ribs',       0,  60, 'linear', NULL),
  ('dongguapaigutang',  'winter_melon',    1, 110, 'linear', NULL),
  ('yumihuluobogutang', 'pork_ribs',       0,  55, 'linear', NULL),
  ('yumihuluobogutang', 'corn',            1,  90, 'linear', NULL),
  ('yumihuluobogutang', 'carrot',          2,  55, 'linear', NULL),
  ('fanqiedanhuatang',  'tomato',          0,  80, 'linear', NULL),
  ('fanqiedanhuatang',  'egg',             1,  40, 'linear', NULL),
  ('xiangguhuaji',      'chicken_legs',    0, 140, 'linear', NULL),
  ('xiangguhuaji',      'shiitake',        1,  60, 'linear', NULL),
  ('xiangjiandaiyu',    'hairtail',        0, 150, 'linear', NULL);

-- 菜粒度的爱吃（001 说好「菜谱表建好后随它一起录」的内容）：家人嘴里说的菜名
INSERT INTO member_loves (member_id, ingredient_id, recipe_id, created_at) VALUES
  ('mom',    NULL, 'qingzhengluyu',     strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dad',    NULL, 'tudouniuniu',       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dabao',  NULL, 'fanqiechaodan',     strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dabao',  NULL, 'kelejichi',         strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xiaobao',NULL, 'yumihuluobogutang', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
