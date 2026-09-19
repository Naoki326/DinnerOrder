-- M1-02 家人与食材字典（总纲 §2.9、§3）
--
-- 本票落两张最小表：
--   * 食材字典（ingredients + ingredient_aliases）—— 规范名 + 别名。时令月份与
--     隐性忌口「含」指针是 #15 的活，它们都是**加列/加表**即可，本票不预设形状。
--   * 家人（members + member_avoid + member_loves）—— 忌口/爱吃建模不对称（总纲 §3 决议 1）：
--     忌口是硬过滤，条目只指向食材；爱吃是软加分，条目可以是食材**或**具体菜。
--     爱吃指向菜的一支（recipe_id）依赖菜谱表（#15），本票只留可空列 + CHECK，
--     接口层暂不收菜粒度条目（见 api/members.ts 的说明），#15 建表后接通。
--
-- 种子数据：食材字典是本家常用食材（#15 导入菜谱时的归一口径）；家人是真实家人
-- （原型 main-ui 分支的 PEOPLE 快照，掌勺者/长辈/小孩齐备），小孩含出生年月——
-- #16 份量引擎要按它现算年龄分带。种子在迁移里只跑一次，此后一律走画像编辑接口改。
--
-- 爱吃的种子只落**食材粒度**：原型 PEOPLE 里的食材叫法直接对应（土豆/牛腩/玉米/排骨/鸡翅），
-- 菜粒度的叫法（红烧肉/番茄炒蛋/可乐鸡翅）与泛指（时蔬/清淡）等 #15 的菜谱表与口味标签建好后随它一起录；
-- 本票的 member_loves.recipe_id 列已为其备好（见上面的 CHECK）。

CREATE TABLE ingredients (
  id   TEXT PRIMARY KEY,
  -- 规范名：全库唯一，买菜聚合与忌口命中都以它为准
  name TEXT NOT NULL UNIQUE
);

-- 别名全局唯一：一个叫法只能指向一个食材，否则「归一」在源头就分叉
CREATE TABLE ingredient_aliases (
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  alias         TEXT NOT NULL PRIMARY KEY
);

CREATE INDEX idx_ingredient_aliases_ingredient ON ingredient_aliases (ingredient_id);

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  -- 大人 / 小孩
  kind        TEXT NOT NULL CHECK (kind IN ('adult', 'child')),
  gender      TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  -- 出生年月 'YYYY-MM'：小孩必填（#16 按年龄分带折算份量），大人可空
  birth_month TEXT CHECK (birth_month IS NULL OR birth_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  -- 掌勺者：餐后回顾的读者（M1 无权限判定，仅用于界面标注与默认当前身份）
  is_cook     INTEGER NOT NULL DEFAULT 0 CHECK (is_cook IN (0, 1)),
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (kind <> 'child' OR birth_month IS NOT NULL)
);

-- 忌口（硬过滤）：条目指向食材字典，本餐任一用餐者命中即排除该菜
CREATE TABLE member_avoid (
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (member_id, ingredient_id)
);

-- 爱吃（软加分）：混合粒度，一条恰好指向一个食材或一道菜（不分档）
CREATE TABLE member_loves (
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ingredient_id TEXT REFERENCES ingredients(id),
  -- 菜粒度：菜谱表在 #15，此处刻意不加外键（SQLite 加外键要重建表）；
  -- #15 建表后由它决定是否补外键与菜名解析。
  recipe_id     TEXT,
  created_at    TEXT NOT NULL,
  CHECK ((ingredient_id IS NOT NULL) + (recipe_id IS NOT NULL) = 1)
);

CREATE INDEX idx_member_loves_member ON member_loves (member_id);

-- 同一家人同一食材 / 同一道菜不重复；两个粒度各一条部分唯一索引
-- （不能用复合主键：SQLite 的 PRIMARY KEY 不拒绝 NULL，部分唯一索引才管得住「恰好一个非空」）
CREATE UNIQUE INDEX idx_member_loves_ingredient
  ON member_loves (member_id, ingredient_id) WHERE ingredient_id IS NOT NULL;
CREATE UNIQUE INDEX idx_member_loves_recipe
  ON member_loves (member_id, recipe_id) WHERE recipe_id IS NOT NULL;

-- ---------------------------------------------------------------- 食材字典种子

INSERT INTO ingredients (id, name) VALUES
  -- 蔬菜 / 菌菇 / 豆制品
  ('tomato',           '番茄'),
  ('potato',           '土豆'),
  ('cucumber',         '黄瓜'),
  ('chinese_cabbage',  '白菜'),
  ('baby_cabbage',     '娃娃菜'),
  ('choy_sum',         '菜心'),
  ('bok_choy',         '上海青'),
  ('spinach',          '菠菜'),
  ('broccoli',         '西兰花'),
  ('carrot',           '胡萝卜'),
  ('white_radish',     '白萝卜'),
  ('winter_melon',     '冬瓜'),
  ('pumpkin',          '南瓜'),
  ('eggplant',         '茄子'),
  ('green_pepper',     '青椒'),
  ('onion',            '洋葱'),
  ('garlic',           '蒜'),
  ('ginger',           '姜'),
  ('scallion',         '葱'),
  ('chives',           '韭菜'),
  ('bitter_melon',     '苦瓜'),
  ('corn',             '玉米'),
  ('bean_sprouts',     '豆芽'),
  ('long_beans',       '豇豆'),
  ('lotus_root',       '莲藕'),
  ('chinese_yam',      '山药'),
  ('celery',           '芹菜'),
  ('lettuce',          '生菜'),
  ('loofah',           '丝瓜'),
  ('shiitake',         '香菇'),
  ('wood_ear',         '木耳'),
  ('enoki',            '金针菇'),
  ('nori',             '紫菜'),
  ('tofu',             '豆腐'),
  ('dried_tofu',       '豆干'),
  -- 肉 / 蛋 / 水产
  ('pork_ribs',        '猪排骨'),
  ('pork_belly',       '五花肉'),
  ('pork_tenderloin',  '里脊'),
  ('pork_mince',       '猪肉末'),
  ('beef_brisket',     '牛腩'),
  ('beef',             '牛肉'),
  ('chicken_wings',    '鸡翅'),
  ('chicken_legs',     '鸡腿'),
  ('whole_chicken',    '整鸡'),
  ('egg',              '鸡蛋'),
  ('shrimp',           '虾'),
  ('shellfish',        '贝类'),
  ('seabass',          '鲈鱼'),
  ('grass_carp',       '草鱼'),
  ('hairtail',         '带鱼'),
  ('offal',            '动物内脏'),
  ('sausage',          '腊肠'),
  ('bacon',            '培根'),
  -- 主粮 / 调料
  ('rice',             '大米'),
  ('flour',            '面粉'),
  ('oyster_sauce',     '蚝油'),
  ('light_soy_sauce',  '生抽'),
  ('dark_soy_sauce',   '老抽'),
  ('vinegar',          '醋'),
  ('cooking_wine',     '料酒'),
  ('tomato_paste',     '番茄酱'),
  ('doubanjiang',      '豆瓣酱'),
  ('chili',            '辣椒'),
  ('sichuan_pepper',   '花椒'),
  ('starch',           '淀粉'),
  ('sugar',            '白糖'),
  ('salt',             '盐'),
  ('cooking_oil',      '食用油'),
  ('sesame_oil',       '香油');

INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES
  ('tomato',          '西红柿'),
  ('tomato',          '蕃茄'),
  ('potato',          '马铃薯'),
  ('potato',          '洋芋'),
  ('cucumber',        '青瓜'),
  ('chinese_cabbage', '大白菜'),
  ('choy_sum',        '菜薹'),
  ('bok_choy',        '小油菜'),
  ('bok_choy',        '青江菜'),
  ('broccoli',        '绿花菜'),
  ('carrot',          '红萝卜'),
  ('white_radish',    '萝卜'),
  ('pumpkin',         '老南瓜'),
  ('eggplant',        '紫茄子'),
  ('green_pepper',    '柿子椒'),
  ('onion',           '圆葱'),
  ('garlic',          '大蒜'),
  ('garlic',          '蒜头'),
  ('ginger',          '生姜'),
  ('scallion',        '小葱'),
  ('scallion',        '香葱'),
  ('bitter_melon',    '凉瓜'),
  ('corn',            '甜玉米'),
  ('corn',            '玉米棒'),
  ('bean_sprouts',    '黄豆芽'),
  ('bean_sprouts',    '绿豆芽'),
  ('long_beans',      '长豆角'),
  ('long_beans',      '豆角'),
  ('lotus_root',      '藕'),
  ('chinese_yam',     '淮山'),
  ('celery',          '西芹'),
  ('celery',          '香芹'),
  ('shiitake',        '冬菇'),
  ('shiitake',        '花菇'),
  ('wood_ear',        '黑木耳'),
  ('wood_ear',        '云耳'),
  ('nori',            '海苔'),
  ('tofu',            '嫩豆腐'),
  ('tofu',            '北豆腐'),
  ('tofu',            '老豆腐'),
  ('dried_tofu',      '香干'),
  ('dried_tofu',      '豆腐干'),
  ('pork_ribs',       '排骨'),
  ('pork_ribs',       '肋排'),
  ('pork_belly',      '猪五花'),
  ('pork_belly',      '三层肉'),
  ('pork_tenderloin', '猪里脊'),
  ('pork_tenderloin', '里脊肉'),
  ('pork_mince',      '肉末'),
  ('pork_mince',      '猪肉馅'),
  ('beef_brisket',    '牛胸肉'),
  ('beef',            '瘦牛肉'),
  ('chicken_wings',   '翅中'),
  ('chicken_wings',   '鸡中翅'),
  ('chicken_legs',    '琵琶腿'),
  ('whole_chicken',   '三黄鸡'),
  ('whole_chicken',   '土鸡'),
  ('egg',             '土鸡蛋'),
  ('shrimp',          '基围虾'),
  ('shrimp',          '对虾'),
  ('shellfish',       '蛤蜊'),
  ('shellfish',       '花甲'),
  ('shellfish',       '扇贝'),
  ('shellfish',       '生蚝'),
  ('shellfish',       '牡蛎'),
  ('seabass',         '海鲈鱼'),
  ('grass_carp',      '鲩鱼'),
  ('hairtail',        '刀鱼'),
  ('offal',           '猪肝'),
  ('offal',           '鸡胗'),
  ('offal',           '猪腰'),
  ('offal',           '猪肚'),
  ('sausage',         '香肠'),
  ('rice',            '米'),
  ('flour',           '小麦粉'),
  ('light_soy_sauce', '酱油'),
  ('vinegar',         '陈醋'),
  ('vinegar',         '米醋'),
  ('cooking_wine',    '黄酒'),
  ('tomato_paste',    '番茄沙司'),
  ('doubanjiang',     '郫县豆瓣'),
  ('chili',           '干辣椒'),
  ('chili',           '小米辣'),
  ('starch',          '生粉'),
  ('starch',          '玉米淀粉'),
  ('sugar',           '白砂糖'),
  ('sugar',           '砂糖'),
  ('salt',            '食盐'),
  ('cooking_oil',     '菜籽油'),
  ('cooking_oil',     '花生油'),
  ('sesame_oil',      '芝麻油');

-- ---------------------------------------------------------------- 家人种子

INSERT INTO members (id, name, emoji, kind, gender, birth_month, is_cook, sort_order, created_at, updated_at) VALUES
  ('mom',    '妈妈', '👩', 'adult', 'female', NULL,      1, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dad',    '爸爸', '👨', 'adult', 'male',   NULL,      0, 2, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dabao',  '大宝', '👦', 'child', 'male',   '2017-05', 0, 3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xiaobao','小宝', '👧', 'child', 'female', '2021-09', 0, 4, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

INSERT INTO member_avoid (member_id, ingredient_id, created_at) VALUES
  ('mom',     'offal',      strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dabao',   'chili',      strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xiaobao', 'shellfish',  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xiaobao', 'shrimp',     strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

INSERT INTO member_loves (member_id, ingredient_id, recipe_id, created_at) VALUES
  ('mom',     'seabass',       NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dad',     'potato',        NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dad',     'beef_brisket',  NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dabao',   'tomato',        NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('dabao',   'chicken_wings', NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xiaobao', 'corn',          NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xiaobao', 'pork_ribs',     NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xiaobao', 'chicken_wings', NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
