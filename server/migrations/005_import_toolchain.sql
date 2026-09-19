-- M1-07 冷启动导入工具（总纲 §2.8、§5；ADR-0006）
--
-- 本票的导入器本身是代码（`server/src/library/` 采集器 + `server/src/domain/library.ts` 落库），
-- 迁移只负责三件**数据资产**的事，以及一条欠账：
--
-- 1. **`recipes.cuisine`（菜系参考 tag）**——总纲 §2.8 要求「口味封闭五标签（多选）+
--    菜系参考 tag（导入时 LLM 初打、转正时掌勺者校对）」，但 #15 只落了口味五标签。
--    本票补这一列：**单一列 + CHECK 白名单**，不建 `recipe_cuisines` 多值表——
--    「参考 tag」是单值参考，多值会让界面与字段名对不上；更关键的是**不与 `recipe_tastes`
--    并存成两套分类**：「甜/辣/酸/咸鲜/清淡」是口味（封闭五标签，参与排序与展示），
--    `cuisine` 是菜系（参考，不参与任何过滤与判定）。两者的值域互不相交，CHECK 里也写死。
--
--    值域口径：中国菜系里**家常菜会真落到的那几个**（川/粤/鲁/苏浙/湘/东北/闽/徽/西北/京）
--    + `家常`（跨菜系的家庭做法，占比最大的一类）。给 50 道菜打 50 个菜系名单没有意义：
--    冷启动导入是「按家常热度筛，不按菜系筛」（§2.8、ADR-0006），菜系只是给家人看的一句参考。
--
-- 2. **食材字典扩充**：中餐菜单里的常客（001 的 70 种是原型家人画像用得上的那一批，
--    导入 150–300 道家常菜时会撞上大量 001 没有的名字：牛肉类、水产、酱料、香料）。
--    与 002 同一纪律：**别名全局唯一**（一个叫法只能指向一个食材），规范名唯一。
--    同时补 002 只有两三条的**隐性忌口「含」指针**（甜面酱含小麦粉、豆豉含大豆）。
--
-- 3. **时令手工表**（总纲 §5「无权威开放数据 → 手工维护 30–40 种常买食材 × 12 月小表」）：
--    002 按「真按时令买」录了 24 种，本票补齐到 **40 种**（补的是新导入的外部菜谱里
--    出现频率最高的家常菜）。口径照旧：**只录当季月份，未录 = 未录/四季有售**——
--    这与「× 12 月」不矛盾：那张小表的形状是 40 行 × 12 列的网格（每一列都落到具体食材上，
--    `domain/library.ts` 的 `seasonGrid()` 与导入报告直接读它），而不是给每个食材都填满 12 个月
--    （填满就等于把时令信号抹成常量，推荐排序的时令位永远同一个分）。
--    002 的既有月份一个不改（那是已确认的自家菜场实情），故补录用 INSERT OR IGNORE。
--
-- 本票**不种新菜谱**：外部池的 150–300 道由导入器从真实数据源采集（HowToCook 仓库 +
-- 下厨房热榜），数据文件随采集命令写在 `server/library-data/`。迁移里再种一批等于把
-- 「导入工具的产出」与「迁移种子」变成两份会漂移的东西。

-- ---------------------------------------------------------------- 菜系参考 tag（#19 承接 #15 的欠账）

-- 菜系参考 tag：**不做过滤、不做判定**，只在菜谱详情里给一句「这是什么路子的菜」。
-- 导入时由 LLM 初打（`llm/import-schema.ts` 的 cuisine 白名单与这里一一对应），
-- 转正时掌勺者校对（#21）。
ALTER TABLE recipes ADD COLUMN cuisine TEXT CHECK (
  cuisine IS NULL OR cuisine IN (
    '川', '粤', '鲁', '苏浙', '湘', '东北', '闽', '徽', '西北', '京', '家常'
  )
);

-- 已有种子的菜系按「这道菜的通行归属」手工回填。刻意留一道不填（香菇滑鸡：粤式家常，
-- 说它粤或家常都行）——`cuisine IS NULL` 是合法状态：导入的菜还没被 LLM 打过 tag 时就是这个值，
-- 转正时（#21）掌勺者校对才有内容。回填只写**不会引起争论**的那些。
UPDATE recipes SET cuisine = '家常' WHERE id IN (
  'hongshaopaigu', 'kelejichi', 'tudouniuniu', 'fanqiechaodan', 'culutudousi',
  'dongguapaigutang', 'yumihuluobogutang', 'fanqiedanhuatang', 'xiangjiandaiyu',
  'fanqieniunan', 'qingchaodouya', 'liangbanhuanggua', 'zicaidanhuatang', 'dongguwanizitang'
);
UPDATE recipes SET cuisine = '粤' WHERE id IN (
  'qingzhengluyu', 'chongcaohuazhengji', 'baizhuoxia', 'suanrongcaixin', 'shangtangwawacai', 'haoyoushengcai'
);
UPDATE recipes SET cuisine = '鲁' WHERE id IN ('tangculiji', 'huangmenji');
UPDATE recipes SET cuisine = '苏浙' WHERE id = 'danchaofan';
UPDATE recipes SET cuisine = '川' WHERE id IN ('mapodoufu', 'gongbaojiding', 'huiguorou', 'jiachangdoufu');
UPDATE recipes SET cuisine = '京' WHERE id = 'culubaicai';

-- ---------------------------------------------------------------- 食材字典扩充

-- 中餐菜单常客（001 里没有的名字）。分组只是给人看的，落库都是同一条字典行。
INSERT INTO ingredients (id, name) VALUES
  -- 肉 / 蛋 / 水产
  ('chicken_breast',      '鸡胸肉'),
  ('chicken_carcass',     '鸡架'),
  ('chicken_feet',        '鸡爪'),
  ('duck',                '鸭子'),
  ('lamb',                '羊肉'),
  ('pork_hock',           '猪蹄'),
  ('pork_loin',           '猪梅花肉'),
  ('pork_liver',          '猪肝'),
  ('pork_intestine',      '猪大肠'),
  ('pork_blood',          '猪血'),
  ('beef_shank',          '牛腱'),
  ('beef_tripe',          '牛肚'),
  ('beef_tongue',         '牛舌'),
  ('luncheon_meat',       '午餐肉'),
  ('ham',                 '火腿'),
  ('quail_egg',           '鹌鹑蛋（生）'),
  ('salted_duck_egg',     '咸鸭蛋'),
  ('crab',                '螃蟹'),
  ('crayfish',            '小龙虾'),
  ('squid',               '鱿鱼'),
  ('octopus',             '章鱼'),
  ('clam',                '花甲'),
  ('oyster',              '生蚝'),
  ('mussel',              '青口'),
  ('scallop',             '扇贝'),
  ('anchovy',             '凤尾鱼'),
  ('silver_carp',         '鲢鱼'),
  ('crucian_carp',        '鲫鱼'),
  ('perch',               '桂鱼'),
  ('salmon',              '三文鱼'),
  ('tuna',                '金枪鱼'),
  ('fish_ball',           '鱼丸'),
  ('dried_shrimp',        '虾皮'),
  ('seaweed_kelp',        '海带'),
  ('kelp_knot',           '海带结'),
  ('nori_sheet',          '紫菜片'),
  -- 蔬菜 / 菌菇 / 豆制品
  ('napa_leaf',           '黄芽白'),
  ('rape',                '油菜'),
  ('kale',                '芥蓝'),
  ('amaranth',            '苋菜'),
  ('water_spinach',       '空心菜'),
  ('chrysanthemum_greens','茼蒿'),
  ('mustard_greens',      '雪里蕻'),
  ('pickled_cabbage',     '酸菜'),
  ('pickled_mustard',     '榨菜'),
  ('pickled_longbean',    '酸豆角'),
  ('mung_bean_sprouts',   '绿豆芽'),
  ('soybean_sprouts',     '黄豆芽'),
  ('snow_peas',           '荷兰豆'),
  ('green_beans',         '四季豆'),
  ('edamame',             '毛豆'),
  ('pea',                 '豌豆'),
  ('cucumber_loofah',     '水瓜'),
  ('taro',                '芋头'),
  ('sweet_potato',        '红薯'),
  ('bamboo_shoot',        '竹笋'),
  ('garlic_sprout',       '蒜薹'),
  ('garlic_chive',        '蒜苗'),
  ('mustard_tuber',       '大头菜'),
  ('okra',                '秋葵'),
  ('celtuce',             '莴笋'),
  ('asparagus_lettuce',   '油麦菜'),
  ('red_pepper',          '红椒'),
  ('bell_pepper',         '彩椒'),
  ('hot_pepper',          '尖椒'),
  ('dried_chili',         '干辣椒'),
  ('red_chili',           '红辣椒'),
  ('wild_pepper',         '小米椒'),
  ('cherry_tomato',       '圣女果'),
  ('zucchini',            '西葫芦'),
  ('pumpkin_vine',        '南瓜藤'),
  ('cabbage_heart',       '娃娃菜心'),
  ('cabbage',             '卷心菜'),
  ('cauliflower',         '菜花'),
  ('coriander',           '香菜'),
  ('lemongrass',          '香茅'),
  ('mint',                '薄荷'),
  ('basil',               '九层塔'),
  ('perilla',             '紫苏'),
  ('chive_flower',        '韭菜花'),
  ('oyster_mushroom',     '平菇'),
  ('king_oyster',         '杏鲍菇'),
  ('seafood_mushroom',    '海鲜菇'),
  ('white_fungus',        '银耳'),
  ('dried_shiitake',      '干香菇'),
  ('agaric',              '石耳干货'),
  ('dried_wood_ear',      '干木耳'),
  ('dried_bean_curd',     '腐竹'),
  ('tofu_skin',           '豆皮'),
  ('tofu_puff',           '油豆腐'),
  ('tofu_pudding',        '豆花'),
  ('fermented_tofu',      '腐乳'),
  ('soybean_paste',       '黄豆酱'),
  ('sweet_bean_sauce',    '甜面酱'),
  ('fermented_black_bean','豆豉'),
  ('sesame_paste',        '纯芝麻酱'),
  ('peanut_butter',       '花生酱'),
  ('yellow_mustard',      '黄芥末'),
  ('worcestershire',      '辣酱油'),
  ('honey',               '蜂蜜'),
  ('cola',                '可乐'),
  ('beer',                '啤酒'),
  ('coconut_milk',        '椰奶'),
  ('curry_cube',          '咖喱块'),
  ('curry_powder',        '印度咖喱粉'),
  ('milk',                '牛奶'),
  ('butter',              '黄油'),
  ('cheese',              '奶酪'),
  ('yogurt',              '酸奶'),
  ('jam',                 '果酱'),
  ('bread',               '面包'),
  ('flour_high_gluten',   '高筋面粉'),
  ('flour_low_gluten',    '低筋面粉'),
  ('millet',              '小米'),
  ('glutinous_rice',      '糯米'),
  ('black_rice',          '黑米'),
  ('cornmeal',            '玉米面'),
  ('oat',                 '燕麦'),
  ('noodles',             '面条'),
  ('instant_noodles',     '方便面'),
  ('bean_thread',         '龙口粉丝'),
  ('vermicelli',          '细粉'),
  ('rice_noodle',         '米粉'),
  ('rice_cake',           '年糕'),
  ('glutinous_rice_flour','糯米粉'),
  ('yeast',               '酵母'),
  ('baking_powder',       '发粉'),
  ('milk_powder',         '奶粉'),
  -- 调料 / 香料（中餐导出的菜单里出现频率最高的那批）
  ('salt_baked',          '海盐'),
  ('chicken_bouillon',    '鸡精'),
  ('monosodium_glutamate','味精（谷氨酸钠）'),
  ('oyster_mushroom_sauce','香菇酱'),
  ('chili_oil',           '辣椒油'),
  ('chili_flakes',        '辣椒粉'),
  ('chili_sauce',         '辣椒酱'),
  ('chili_bean_sauce',    '香辣酱'),
  ('pickled_chili',       '泡椒'),
  ('douchi_chili',        '老干妈'),
  ('white_pepper',        '白胡椒粉'),
  ('black_pepper',        '黑胡椒'),
  ('sichuan_peppercorn_oil','花椒油'),
  ('chopped_garlic_sauce','蒜蓉辣酱'),
  ('oyster_essence',      '蚝油汁'),
  ('rice_vinegar',        '白醋'),
  ('sweet_rice_vinegar',  '香醋'),
  ('ketchup',             '番茄沙司'),
  ('pixian_douban',       '郫县豆瓣酱'),
  ('light_soy',           '味极鲜'),
  ('sesame_seed',         '白芝麻'),
  ('black_sesame',        '黑芝麻'),
  ('peanut',              '花生'),
  ('walnut',              '核桃'),
  ('cashew',              '腰果'),
  ('star_anise',          '八角'),
  ('cinnamon',            '桂皮'),
  ('bay_leaf',            '香叶'),
  ('fennel_seed',         '茴香'),
  ('cumin',               '孜然'),
  ('five_spice',          '五香粉（复合）'),
  ('thirteen_spice',      '十三香'),
  ('clove',               '丁香'),
  ('cardamom',            '豆蔻'),
  ('turmeric',            '姜黄粉'),
  ('coriander_powder',    '香菜粉'),
  ('chicken_powder',      '鸡肉粉'),
  ('vegetable_stock',     '蔬菜高汤'),
  ('chicken_stock',       '高汤'),
  ('pork_lard',           '猪油'),
  ('olive_oil',           '橄榄油'),
  ('corn_oil',            '玉米油'),
  ('rapeseed_oil',        '菜籽油'),
  ('peanut_oil',          '花生油'),
  ('water',               '水'),
  ('hot_water',           '开水'),
  ('rock_sugar',          '冰糖'),
  ('brown_sugar',         '红糖'),
  ('condensed_milk',      '炼乳'),
  ('cream',               '奶油'),
  ('gelatin',             '吉利丁'),
  ('vanilla',             '香草精'),
  ('lemon',               '柠檬'),
  ('lime',                '青柠'),
  ('orange_peel',         '陈皮'),
  ('goji',                '枸杞'),
  ('red_date',            '红枣'),
  ('angelica',            '当归'),
  ('codonopsis',          '党参'),
  ('astragalus',          '黄芪'),
  ('lotus_seed',          '干莲子'),
  ('chinese_hawthorn',    '山楂'),
  ('fermented_rice_wine', '醪糟'),
  ('baijiu',              '白酒'),
  ('sesame_paste_dip',    '麻酱');

-- 补两味互换表用到、字典还没有的：干黄豆与豆浆（WS/T 554 附录 A 的大豆组）。
-- **必须排在「含」指针之前**：隐性忌口的指针两头都是字典行，外键要求它们先存在。
INSERT INTO ingredients (id, name) VALUES ('soybean', '干黄豆'), ('soy_milk', '豆浆');

INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES
  ('chicken_breast',      '鸡脯肉'),
  ('chicken_breast',      '鸡胸'),
  ('chicken_feet',        '凤爪'),
  ('pork_hock',           '肘子'),
  ('pork_loin',           '梅花肉'),
  ('pork_liver',          '肝'),
  ('beef_shank',          '牛腱子'),
  ('lamb',                '羊肉片'),
  ('crab',                '大闸蟹'),
  ('crab',                '梭子蟹'),
  ('squid',               '鱿鱼须'),
  ('mussel',              '淡菜'),
  ('scallop',             '扇贝肉'),
  ('perch',               '鳜鱼'),
  ('seaweed_kelp',        '昆布'),
  ('kelp_knot',           '海带丝'),
  ('nori_sheet',          '海苔片'),
  ('napa_leaf',           '黄白菜'),
  ('kale',                '广东芥蓝'),
  ('water_spinach',       '蕹菜'),
  ('chrysanthemum_greens','蓬蒿'),
  ('pickled_cabbage',     '东北酸菜'),
  ('pickled_mustard',     '涪陵榨菜'),
  ('mung_bean_sprouts',   '豆芽菜'),
  ('snow_peas',           '甜豆'),
  ('edamame',             '青豆'),
  ('sweet_potato',        '地瓜'),
  ('bamboo_shoot',        '春笋'),
  ('bamboo_shoot',        '冬笋'),
  ('garlic_sprout',       '蒜苔'),
  ('garlic_chive',        '青蒜'),
  ('celtuce',             '莴苣'),
  ('asparagus_lettuce',   '莜麦菜'),
  ('bell_pepper',         '甜椒'),
  ('hot_pepper',          '青尖椒'),
  ('dried_chili',         '辣椒干'),
  ('zucchini',            '角瓜'),
  ('cauliflower',         '花菜'),
  ('cabbage',             '圆白菜'),
  ('cabbage',             '包菜'),
  ('coriander',           '芫荽'),
  ('basil',               '罗勒'),
  ('coriander',           '香菜叶'),
  ('king_oyster',         '鸡腿菇'),
  ('shiitake',            '鲜香菇'),
  ('white_fungus',        '白木耳'),
  ('dried_wood_ear',      '木耳丝'),
  ('dried_bean_curd',     '腐竹段'),
  ('tofu_skin',           '千张'),
  ('tofu_skin',           '豆腐皮'),
  ('tofu_puff',           '油豆泡'),
  ('fermented_tofu',      '豆腐乳'),
  ('soybean_paste',       '大豆酱'),
  ('sweet_bean_sauce',    '甜酱'),
  ('fermented_black_bean','阳江豆豉'),
  ('worcestershire',      '喼汁'),
  ('curry_cube',          '咖喱'),
  ('flour_high_gluten',   '高粉'),
  ('flour_low_gluten',    '低粉'),
  ('millet',              '小黄米'),
  ('noodles',             '挂面'),
  ('noodles',             '切面'),
  ('vermicelli',          '细粉丝'),
  ('rice_noodle',         '米线'),
  ('rice_cake',           '水磨年糕'),
  ('glutinous_rice_flour','江米粉'),
  ('milk_powder',         '全脂奶粉'),
  ('chicken_bouillon',    '鸡粉'),
  ('chili_flakes',        '辣椒面'),
  ('chili_flakes',        '红辣椒粉'),
  ('chili_sauce',         '蒜蓉辣酱'),
  ('douchi_chili',        '老干妈辣酱'),
  ('white_pepper',        '胡椒粉'),
  ('white_pepper',        '白胡椒'),
  ('black_pepper',        '黑胡椒粉'),
  ('black_pepper',        '现磨黑胡椒'),
  ('sichuan_peppercorn_oil','藤椒油'),
  ('rice_vinegar',        '醋精'),
  ('ketchup',             '番茄蘸酱'),
  ('light_soy',           '生抽王'),
  ('sesame_seed',         '熟芝麻'),
  ('star_anise',          '大料'),
  ('cinnamon',            '桂枝'),
  ('fennel_seed',         '小茴香'),
  ('cumin',               '孜然粉'),
  ('cumin',               '孜然粒'),
  ('thirteen_spice',      '十三香粉'),
  ('clove',               '丁香粒'),
  ('cardamom',            '白豆蔻'),
  ('turmeric',            '姜黄'),
  ('chicken_stock',       '鸡汤'),
  ('vegetable_stock',     '素高汤'),
  ('pork_lard',           '猪板油'),
  ('corn_oil',            '玉米胚芽油'),
  ('rapeseed_oil',        '低芥酸菜籽油'),
  ('hot_water',           '热水'),
  ('rock_sugar',          '冰块糖'),
  ('brown_sugar',         '赤砂糖'),
  ('cream',               '淡奶油'),
  ('cream',               '动物奶油'),
  ('lemon',               '柠檬汁'),
  ('goji',                '枸杞子'),
  ('red_date',            '大枣'),
  ('red_date',            '枣'),
  ('astragalus',          '黄芪'),
  ('fermented_rice_wine', '酒酿'),
  ('fermented_rice_wine', '米酒'),
  ('baijiu',              '二锅头'),
  ('sesame_paste_dip',    '麻酱');

-- 隐性忌口「含」指针补全（002 只种了蚝油→贝类、豆瓣酱→辣椒）
INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ('soybean', '黄豆'), ('soy_milk', '豆奶');

INSERT INTO ingredient_contains (ingredient_id, contains_id) VALUES
  ('sweet_bean_sauce',    'flour'),
  ('fermented_black_bean','soybean'),
  ('soybean_paste',       'soybean'),
  ('worcestershire',      'anchovy'),
  ('luncheon_meat',       'pork_mince'),
  ('fish_ball',           'grass_carp');

-- 互换表里能对上字典、但当时没有挂 ingredient_id 的两条（干黄豆 / 豆浆）现在挂上：
-- #23 买菜聚合要用（同一食材的市品重换算）。
UPDATE exchange_items SET ingredient_id = 'soybean'  WHERE id = 'soy_dried_soybean';
UPDATE exchange_items SET ingredient_id = 'soy_milk' WHERE id = 'soy_soy_milk';
UPDATE exchange_items SET ingredient_id = 'tofu'     WHERE id = 'soy_north_tofu';
UPDATE exchange_items SET ingredient_id = 'dried_tofu' WHERE id = 'soy_dried_tofu';
-- 互换表里那几条「有字典食材但没挂」的，一并挂上（同一条纪律：字典是唯一受控表）。
-- 本票扩充字典后，新出现的对应关系也在这里补：互换表与字典**对齐**，是 #23 买菜聚合的前提
-- （聚合要回答「50g 大米 ≈ 米饭 110g」时，得知道那是同一个食材的两副面孔）。
-- 只挂**名字就是字典规范名**的那些；熟食/市品口径的中转项（米饭、馒头、粥、烙饼、
-- 内酯豆腐这类专有叫法）保持为 null——给它们硬挂一个字典食材，等于把「375 g 米粥」
-- 当成「375 g 大米」并进买菜聚合，那正是 003 注释里明确要避免的事。
UPDATE exchange_items SET ingredient_id = 'cucumber'         WHERE id = 'vegetable_cucumber';
UPDATE exchange_items SET ingredient_id = 'chinese_cabbage'  WHERE id = 'vegetable_chinese_cabbage';
UPDATE exchange_items SET ingredient_id = 'whole_chicken'    WHERE id = 'meat_poultry_whole';
UPDATE exchange_items SET ingredient_id = 'celtuce'          WHERE id = 'vegetable_celtuce';
UPDATE exchange_items SET ingredient_id = 'sweet_potato'     WHERE id = 'staple_sweet_potato';
UPDATE exchange_items SET ingredient_id = 'noodles'          WHERE id IN ('staple_dried_noodles', 'staple_fresh_noodles');
UPDATE exchange_items SET ingredient_id = 'bread'            WHERE id = 'staple_bread';
UPDATE exchange_items SET ingredient_id = 'chicken_breast'   WHERE id = 'meat_chicken_breast';
UPDATE exchange_items SET ingredient_id = 'dried_bean_curd'  WHERE id = 'soy_tofu_skin';
UPDATE exchange_items SET ingredient_id = 'cheese'           WHERE id = 'dairy_cheese';
UPDATE exchange_items SET ingredient_id = 'milk_powder'      WHERE id = 'dairy_milk_powder';
UPDATE exchange_items SET ingredient_id = 'yogurt'           WHERE id = 'dairy_yogurt';

-- 真数据里出现过、字典还没有的两味（**必须排在别名之前**：别名指向它们，外键要求先存在）
INSERT INTO ingredients (id, name) VALUES ('chestnut', '板栗'), ('bean_paste', '柱侯酱');

-- HowToCook 真数据跑出来的等价叫法（第二次补录）：这些名字在 372 篇里成规模出现，
-- 归不上的代价是「整道菜的食材少一项」——补齐比在报告里列一大堆失败项有价值。
INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES
  ('sugar',               '糖'),
  ('garlic',              '蒜瓣'),
  ('garlic',              '蒜蓉'),
  ('garlic',              '蒜末'),
  ('ginger',              '姜末'),
  ('ginger',              '姜片'),
  ('ginger',              '生姜末'),
  ('scallion',            '葱花'),
  ('scallion',            '葱段'),
  ('scallion',            '葱白'),
  ('scallion',            '大葱'),
  ('cooking_oil',         '油'),
  ('cooking_oil',         '植物油'),
  ('sesame_oil',          '麻油'),
  ('water',               '清水'),
  ('water',               '饮用水'),
  ('monosodium_glutamate','味精'),
  ('shrimp',              '虾仁'),
  ('clam',                '蛤蜊肉'),
  ('pork_mince',          '肉沫'),
  ('pork_mince',          '肉馅'),
  ('beef',                '瘦肉'),
  ('beef',                '纯瘦肉'),
  ('chicken_legs',        '鸡腿肉'),
  ('chicken_breast',      '鸡胸肉'),
  ('spinach',             '青菜'),
  ('starch',              '土豆淀粉'),
  ('five_spice',          '五香粉'),
  ('bay_leaf',            '月桂叶'),
  ('oyster_mushroom',     '白蘑菇'),
  ('king_oyster',         '白玉菇'),
  ('seafood_mushroom',    '蟹味菇'),
  ('chestnut',            '板栗'),
  ('beef',                '肥牛'),
  ('pork_belly',          '带皮五花肉'),
  ('noodles',             '意大利面'),
  ('rice',                '巴斯马蒂香米'),
  ('ham',                 '叉烧'),
  ('bean_paste',          '柱侯酱'),
  ('chestnut',            '栗子'),
  ('bean_paste',          '海鲜酱'),
  ('shrimp',              '罗氏虾'),
  ('shrimp',              '阿根廷红虾'),
  ('grass_carp',          '巴沙鱼'),
  ('seabass',             '桂花鱼');

-- ---------------------------------------------------------------- 时令手工表（40 种常买 × 12 月）

-- 总纲 §5：「时令食材**无权威开放数据** → 手工维护 30–40 种常买食材 × 12 月小表（按自家菜场
-- 实情录入），存食材字典」。002 已按「真按时令买」录了 24 种；本票补齐到 **40 种**——
-- 补的这批是新导入的外部菜谱里出现频率最高的家常菜（土豆、洋葱、蒜、葱、姜、生菜、
-- 四季豆、荷兰豆、毛豆、卷心菜、菜花、空心菜、秋葵、茼蒿、竹笋、红薯）。
--
-- 口径（与 002 一致，不新造第二套）：**只录「当季」月份，未录 = 未录/四季有售**。
-- 「× 12 月」指的是这份手工表的**形状是一张 40 行 × 12 列的网格**——每一列（月）都落到了具体
-- 食材上（`domain/library.ts` 的 `seasonGrid()` 与导入报告就是把这 12 列原样读出来）；
-- 它**不是**「每个食材都填满 12 个月」：那样等于把「时令」
-- 这个信号抹平成常量，推荐排序里的时令位就永远是同一个分。
-- 「未录 = 四季有售」这条口径由 #17 审查确认正当（见 docs/agents/open-items.md 的「判断性但刻意不改」）：
-- 拿「未录」当「不时令」过滤，一次就会把整个四季皆宜的库排掉。
--
-- 补录用 INSERT OR IGNORE：002 已有的月份**一个不改**（那是已确认的自家菜场实情），
-- 重复月份在这里是重复劳动而不是冲突。

INSERT OR IGNORE INTO ingredient_season_months (ingredient_id, month) VALUES
  -- 土豆：新薯秋末上市，冬储到春节前后
  ('potato',            10), ('potato',            11), ('potato',            12), ('potato',             1),
  -- 洋葱：夏收
  ('onion',              5), ('onion',              6), ('onion',              7), ('onion',              8),
  -- 蒜：新蒜夏初
  ('garlic',             5), ('garlic',             6), ('garlic',             7),
  -- 葱：冬葱最香
  ('scallion',          11), ('scallion',          12), ('scallion',           1), ('scallion',           2),
  -- 姜：秋收
  ('ginger',             9), ('ginger',            10), ('ginger',            11),
  -- 生菜：秋冬春
  ('lettuce',           10), ('lettuce',           11), ('lettuce',           12), ('lettuce',            1),
  ('lettuce',            2), ('lettuce',            3),
  -- 四季豆 / 荷兰豆 / 毛豆：夏天
  ('green_beans',        6), ('green_beans',        7), ('green_beans',        8), ('green_beans',        9),
  ('snow_peas',          4), ('snow_peas',          5), ('snow_peas',          6), ('snow_peas',         10),
  ('snow_peas',         11),
  ('edamame',            6), ('edamame',            7), ('edamame',            8), ('edamame',            9),
  -- 卷心菜 / 菜花：冬春
  ('cabbage',           11), ('cabbage',           12), ('cabbage',            1), ('cabbage',            2),
  ('cabbage',            3),
  ('cauliflower',       10), ('cauliflower',       11), ('cauliflower',       12), ('cauliflower',        1),
  ('cauliflower',        2),
  -- 空心菜 / 秋葵：盛夏
  ('water_spinach',      5), ('water_spinach',      6), ('water_spinach',      7), ('water_spinach',      8),
  ('water_spinach',      9),
  ('okra',               6), ('okra',               7), ('okra',               8), ('okra',               9),
  -- 茼蒿：冬春
  ('chrysanthemum_greens', 11), ('chrysanthemum_greens', 12), ('chrysanthemum_greens', 1),
  ('chrysanthemum_greens',  2), ('chrysanthemum_greens',  3),
  -- 竹笋：春笋 3–5 月（冬笋另算，同一条食材）
  ('bamboo_shoot',       3), ('bamboo_shoot',       4), ('bamboo_shoot',       5),
  -- 红薯：秋收
  ('sweet_potato',       9), ('sweet_potato',      10), ('sweet_potato',      11), ('sweet_potato',      12);

-- ---------------------------------------------------------------- 份量重标的存储形态（本票新增）

-- 总纲 §2.8：「模糊份量（「适量」）导入/转正时**一律由 LLM 重标到成人份克数**」。
-- 外部数据源里大量食材项写的是「适量 / 少许 / 两勺 / 3 瓣」——没有克数。导入时这些项的意义
-- 必须留得住（否则忌口关联与买菜聚合都会少食材），但克数要等 LLM 重标。于是需要一个
-- **「这一项还等着重标」的显式状态**：
--
--   `adult_grams = 0` **就是那个状态**（002 的 CHECK 原本是 `> 0`，本票放宽为 `>= 0`）。
--   重标成功后写回正数克数，状态自然消失——不需要第二个「是否可信」的布尔列
--   （两套机制说同一件事就是会漂移的地方）。
--
-- 为什么要重建表：SQLite 不能 ALTER 掉 CHECK 约束（只能改列名/加列）。这与 002 重建
-- member_loves 补外键是同一路数——同一条纪律在不同票上的复用，不是新发明。
-- 本票在这张表上要加两样东西（放宽 CHECK + 存份量原文），一次重建落完，
-- 不让同一张表在同一票里被重建两遍。
--
-- `source_quantity`：**采集到的份量原文**（`DraftRecipe.ingredients[].quantity`，形如
-- 「两勺」「约 3~4 斤」「1 只（大约 300g） * 份数」）。它的用途只有两个：给 LLM 重标当
-- 证据（`server/src/llm/import-schema.ts` 的纪律 2：模型看到的是原文，不是我们替它猜的数）、
-- 给报告 `relabel.pending` 显示。**它不进份量计算**——份量引擎只读 `adult_grams`
-- （ADR-0004：数值路径纯规则查表，LLM 不进数值路径）。
-- 允许 NULL：002/004 种子的家庭菜谱没有「来源原文」这回事（克数由掌勺者确认）。
--
-- 放宽的**代价**要写明：从这一刻起，「0 克」是合法值。谁都不许拿它当「零克食材」去算份量：
--   份量引擎算出来就是 0（用户看到的是这道菜少了一个食材），而报告里
--   `relabel.pending` 会把它列出来——这是**刻意留下的可见欠账**，不是静默错误。

CREATE TABLE recipe_ingredients_new (
  recipe_id    TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  position     INTEGER NOT NULL,
  -- 成人份生重克数基准；**0 = 模糊份量待 LLM 重标**（见上面的说明）
  adult_grams  REAL NOT NULL CHECK (adult_grams >= 0),
  scaling      TEXT NOT NULL DEFAULT 'linear' CHECK (scaling IN ('linear', 'fixed')),
  raw_cooked_anchor TEXT,
  -- 采集到的份量原文（仅作重标证据与报告显示，不进份量计算）；002/004 的种子行为 NULL
  source_quantity   TEXT,
  PRIMARY KEY (recipe_id, ingredient_id),
  UNIQUE (recipe_id, position)
);

INSERT INTO recipe_ingredients_new (recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor, source_quantity)
  SELECT recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor, NULL FROM recipe_ingredients;

DROP TABLE recipe_ingredients;
ALTER TABLE recipe_ingredients_new RENAME TO recipe_ingredients;

CREATE INDEX idx_recipe_ingredients_ingredient ON recipe_ingredients (ingredient_id);
