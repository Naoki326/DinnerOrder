-- M1-05 整餐推荐管线：外部菜谱池种子（总纲 §2.8、§4；ADR-0006）
--
-- 外部池的**存储形态就是 `recipes.status = 'draft'`**：它不是一张新表，也不进推荐池常态
-- （推荐池唯一来源是转正态的家庭菜谱，见 002 文件头与 domain/recipes.ts）。#19 的批量导入
-- （HowToCook 150–300 道）落库时就写这个状态，本票只种少量样张，够「家庭池某位 <3 时补位」
-- 这条路径与 E2E 跑通。补位菜在推荐里带 `origin='external'`，界面上显著标「没做过」；
-- 上桌做过、掌勺者转正（#21）后才变成家庭菜谱。
--
-- 两条纪律：
--   1. 所有食材引用必须落在 001/002 已有的食材字典上（字典是全库唯一受控表，外键 RESTRICT）。
--   2. 适季月份照实写：外部池也要过时令检索——醋溜白菜在 9 月不该被推荐，凉拌黄瓜该。
--      种子食材**刻意混入**会命中本家忌口的项（辣椒 / 豆瓣酱含辣椒 / 蚝油类），
--      这样「忌口硬过滤」在这条路径上也有真实样本可测（大宝忌辣、小宝忌贝类与虾）。

INSERT INTO recipes (id, name, kind, effort, status, source, steps) VALUES
  ('gongbaojiding',    '宫保鸡丁',   'meat',      'medium', 'draft', 'howtocook', '鸡腿肉切丁腌 15 分钟，干辣椒花椒爆香，下鸡丁炒散，加料汁收浓，起锅前放葱段。'),
  ('huiguorou',        '回锅肉',     'meat',      'medium', 'draft', 'howtocook', '五花肉整块煮 20 分钟切薄片，下锅煸出油，加豆瓣酱炒出红油，下青椒断生。'),
  ('fanqieniunan',     '番茄牛腩',   'meat',      'heavy',  'draft', 'howtocook', '牛腩焯水炒香，加番茄块炒出汁，加水小火炖 1 小时，收汁加盐。'),
  ('qingchaodouya',    '清炒豆芽',   'veg',       'quick',  'draft', 'howtocook', '豆芽洗净沥干，热锅爆香蒜末，大火快炒 1 分钟，加盐出锅。'),
  ('culubaicai',       '醋溜白菜',   'veg',       'quick',  'draft', 'scraped',   '白菜帮斜刀切片，热油爆香干辣椒，大火翻炒，沿锅边淋醋，加盐糖出锅。'),
  ('liangbanhuanggua', '凉拌黄瓜',   'veg',       'quick',  'draft', 'llm',       '黄瓜拍裂切段，加蒜末、醋、香油、少许盐拌匀，冷藏 10 分钟更爽口。'),
  ('jiachangdoufu',    '家常豆腐',   'veg',       'medium', 'draft', 'howtocook', '豆腐切三角片煎金黄，肉末炒散加豆瓣酱，回锅与豆腐同烧 5 分钟，勾芡。'),
  ('zicaidanhuatang',  '紫菜蛋花汤', 'soup_veg',  'quick',  'draft', 'howtocook', '水开下紫菜煮 1 分钟，淋蛋液成花，加盐与香油。'),
  ('dongguawanizitang','冬瓜丸子汤', 'soup_meat', 'medium', 'draft', 'scraped',   '猪肉末加姜末搅上劲挤成丸子，水开下丸子与冬瓜片，煮 10 分钟加盐。');

INSERT INTO recipe_aliases (recipe_id, alias) VALUES
  ('gongbaojiding', '宫爆鸡丁'),
  ('fanqieniunan',  '番茄炖牛腩'),
  ('liangbanhuanggua', '拍黄瓜');

INSERT INTO recipe_tastes (recipe_id, taste) VALUES
  ('gongbaojiding',    '辣'),   ('gongbaojiding',    '咸鲜'),
  ('huiguorou',        '辣'),   ('huiguorou',        '咸鲜'),
  ('fanqieniunan',     '酸'),   ('fanqieniunan',     '咸鲜'),
  ('qingchaodouya',    '清淡'),
  ('culubaicai',       '酸'),   ('culubaicai',       '清淡'),
  ('liangbanhuanggua', '清淡'), ('liangbanhuanggua', '酸'),
  ('jiachangdoufu',    '辣'),   ('jiachangdoufu',    '咸鲜'),
  ('zicaidanhuatang',  '清淡'),
  ('dongguawanizitang','清淡');

-- 适季月份只给真按时令做的写；不写 = 四季皆宜（与家庭菜谱同一口径）
INSERT INTO recipe_season_months (recipe_id, month) VALUES
  ('culubaicai',        11), ('culubaicai',        12), ('culubaicai',         1), ('culubaicai',         2),
  ('liangbanhuanggua',   5), ('liangbanhuanggua',   6), ('liangbanhuanggua',   7), ('liangbanhuanggua',   8),
  ('liangbanhuanggua',   9),
  ('dongguawanizitang',  6), ('dongguawanizitang',  7), ('dongguawanizitang',  8), ('dongguawanizitang',  9);

INSERT INTO recipe_ingredients (recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor) VALUES
  ('gongbaojiding',    'chicken_legs',   0, 140, 'linear', NULL),
  ('gongbaojiding',    'chili',          1,   6, 'fixed',  NULL),
  ('gongbaojiding',    'scallion',       2,  10, 'fixed',  NULL),
  ('huiguorou',        'pork_belly',     0, 130, 'linear', NULL),
  ('huiguorou',        'green_pepper',   1,  50, 'linear', NULL),
  -- 豆瓣酱含辣椒（002 的「含」指针）：回锅肉对忌辣的人整体排除
  ('huiguorou',        'doubanjiang',    2,  15, 'fixed',  NULL),
  ('fanqieniunan',     'beef_brisket',   0, 110, 'linear', NULL),
  ('fanqieniunan',     'tomato',         1, 120, 'linear', NULL),
  ('qingchaodouya',    'bean_sprouts',   0, 160, 'linear', NULL),
  ('qingchaodouya',    'garlic',         1,   8, 'fixed',  NULL),
  ('culubaicai',       'chinese_cabbage',0, 180, 'linear', NULL),
  ('culubaicai',       'vinegar',        1,   8, 'fixed',  NULL),
  ('liangbanhuanggua', 'cucumber',       0, 150, 'linear', NULL),
  ('liangbanhuanggua', 'garlic',         1,   8, 'fixed',  NULL),
  ('liangbanhuanggua', 'vinegar',        2,   6, 'fixed',  NULL),
  ('jiachangdoufu',    'tofu',           0, 180, 'linear', NULL),
  ('jiachangdoufu',    'pork_mince',     1,  30, 'linear', NULL),
  ('jiachangdoufu',    'doubanjiang',    2,  12, 'fixed',  NULL),
  ('zicaidanhuatang',  'nori',           0,   5, 'fixed',  NULL),
  ('zicaidanhuatang',  'egg',            1,  40, 'linear', NULL),
  ('dongguawanizitang','winter_melon',   0, 120, 'linear', NULL),
  ('dongguawanizitang','pork_mince',     1,  60, 'linear', NULL),
  ('dongguawanizitang','ginger',         2,   5, 'fixed',  NULL);
