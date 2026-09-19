-- M1-08 反馈、餐后回顾与冷藏期（总纲 §2.5、§4①；ADR-0005）
--
-- 本票落两块：
--
-- 1. **反馈记录（菜品 × 家人：点踩/赞 + 快捷标签）**。这是「吃后感」这一侧的唯一持久化实体：
--    * 反馈**不是留痕**（不挂 meal_events）。留痕记的是「菜单的变化」（ADR-0007），而一条反馈
--      是**可以改主意的**（点错了要重按）——append-only 的事件流里改主意只能再追加一条，
--      读的时候还要自己折叠「最新一条说了算」。这里用一张普通表 + 每（餐槽 × 菜 × 家人）一行，
--      重按是 UPDATE 而不是「历史里再堆一条」，语义直接对上「当前这家人对这道菜的看法」。
--    * 行里存 `slot_id`（哪一餐的这道菜）：餐后回顾按「这一餐吃过什么」列卡，菜单阶段的反馈
--      也归到当时那一餐；同一个人对同一道菜在**不同餐**可以说不同的话（午餐说太油、晚餐改口）。
--      唯一键因此是 (slot_id, recipe_id, member_id) 而不是 (recipe_id, member_id)。
--    * `updated_on` 是家庭时区的日历日期（与 meal_events.slot_date 同一套口径）：近 30 天摘要的
--      窗口是**家里的日期**，不是 UTC 瞬间——否则东八区晚上 8 点之后写的反馈会掉到前一天。
--
-- 2. **家规表（单例配置，总纲 §3：家规 = 一份可调的单例配置）**。本票只放自己需要的可配值：
--    **冷藏期天数**（默认 14）与**餐次截止时刻**（午 14:00 / 晚 21:00——原先是
--    `domain/family-time.ts` 里的实施者自定常量，总纲 §3 说「家规全部可调」，台账指名归本票）。
--    单行表 + `CHECK (id = 1)`：SQLite 没有「单例」类型，就用主键把「只有一份」钉死，
--    不给第二行留位置（读家规的地方也就不必处理「有多份怎么办」）。
--
-- 本票**不把**推荐管线的其余常量（基线荤素、去重窗口、LLM 超时…）搬进这张表：那是 #26 的
-- 统一收口（见 domain/recommendation.ts 里那几处 TODO）。这里只落本票 AC 要的可配值，
-- 表名与形状留给 #22 加留量上浮系数（ALTER TABLE 追加列即可，单行表的形状不变）。

-- ---------------------------------------------------------------- 反馈记录（菜品 × 家人）

CREATE TABLE dish_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 菜谱行不删（退役也保留，历史要能查），所以这里是 RESTRICT 而不是 CASCADE
  recipe_id  TEXT NOT NULL REFERENCES recipes(id),
  -- 当时那一餐（'YYYY-MM-DD:lunch|dinner'）。不带外键：没有可变的餐槽表（002 的说明）
  slot_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- 点踩 / 点赞（布尔语义，不叠加）
  verdict    TEXT NOT NULL CHECK (verdict IN ('like', 'dislike')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 家庭时区的日历日期：近 30 天摘要按它开窗口（与 meal_events.slot_date 同一口径）
  updated_on TEXT NOT NULL,
  -- 同一个人对同一餐的同一道菜只有一条当前看法（重按是 UPDATE 不是追加）
  UNIQUE (slot_id, recipe_id, member_id)
);

-- 冷藏期查询的形状：按菜谱找点踩（domain/feedback.ts 的 coolOffMap）
CREATE INDEX idx_dish_feedback_recipe ON dish_feedback (recipe_id, verdict, updated_on);
CREATE INDEX idx_dish_feedback_slot ON dish_feedback (slot_id);

-- 快捷标签（总纲 §2.5、CONTEXT「快捷标签」）：值域**封闭**，写死在 CHECK 里——
-- 与 recipe_tastes 的封闭五标签同一理由：开放字符串喂给 LLM 就是一团没法聚合的自由文本。
-- 就 4 个（总纲 §2.5 写的「3–4 个」）：太油 / 太甜 / 量太多 / 量太少——家人嘴里真会说的那几句。
-- 标签挂在一条反馈上（随它一起改/删）：`domain/feedback.ts` 的 FEEDBACK_TAGS 是代码侧的同一值域。
CREATE TABLE dish_feedback_tags (
  feedback_id INTEGER NOT NULL REFERENCES dish_feedback(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL CHECK (tag IN ('太油', '太甜', '量太多', '量太少')),
  PRIMARY KEY (feedback_id, tag)
);

-- ---------------------------------------------------------------- 家规（单例配置）

CREATE TABLE family_rules (
  -- 单例：主键恒 1，「只有一份家规」由 schema 保证，不靠约定
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  -- 冷藏期：某菜被任一本餐用餐者点踩后退出的推荐窗口（默认 14 天，到期自动解除）
  cool_off_days      INTEGER NOT NULL CHECK (cool_off_days BETWEEN 1 AND 365),
  -- 餐次截止时刻（家庭时区，整点）：过了这个点这一餐就不能再定/改
  lunch_cutoff_hour  INTEGER NOT NULL CHECK (lunch_cutoff_hour BETWEEN 0 AND 23),
  dinner_cutoff_hour INTEGER NOT NULL CHECK (dinner_cutoff_hour BETWEEN 0 AND 23),
  updated_at         TEXT NOT NULL
);

-- 缺省家规：与 CONTEXT/总纲的默认值一致（冷藏 14 天、午 14:00 / 晚 21:00 截止）。
-- 单例行在迁移里种下，于是测试 harness、E2E 库、生产库三条路径拿到同一份初值。
INSERT INTO family_rules (id, cool_off_days, lunch_cutoff_hour, dinner_cutoff_hour, updated_at)
VALUES (1, 14, 14, 21, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
