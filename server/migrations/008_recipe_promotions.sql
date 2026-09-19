-- M1-09 转正台账（总纲 §2.8「治理：状态机 草稿 → 转正 → 退役；编辑留痕」；ADR-0006）
--
-- 转正本身**不新增实体、不加新状态**：它就是把一行 `recipes.status` 从 `draft` 改成 `active`
-- （ADR-0006 的「双层库」只是一张表上的状态机，外部池 = 还没转正的那些菜谱）。
-- 迁移里因此没有新列、没有新表型，只有一张**编辑留痕**表；另在文件末种一条本票自己的
-- 待重标样张（外部池的草稿样张，理由与纪律见那里）。
--
-- * **为什么留痕**：转正是唯一一次「LLM 直接改写已经存在的菜谱行」的操作（导入只写新草稿，
--   不改别的行）。改完就没人说得清「这道菜原来是什么样、谁在什么时候按谁的口述改的」——
--   而「为什么是家里这个版本」正是这道菜进家庭库之后要能回答的问题。台账记的是**这一次编辑**：
--   谁（掌勺者）、何时、口述差异原文、菜系从什么改成什么，外加 LLM 调用元数据（模型名 /
--   prompt 版本 / 耗时）——与 `meal_events` 的 LLM 元数据同一套纪律（总纲 §3 决议 3：
--   模板进代码库 git 管版本，留痕里存版本号，历史可对回当时的模板）。
-- * **为什么不存改写前后的完整快照**：状态机只允许 draft → active，转正后还能退役（行保留），
--   菜谱本身没有「版本历史」这个概念（§2.8 只要求「编辑留痕」）。存快照就等于发明一套没有
--   任何读取口的历史机制；台账把「有人改过什么」说清楚就够了。日后真要看完整旧版，
--   从 prompt 版本 + 差异原文可以重建（LLM 改写是确定输入的一部分）。
-- * **与 `dish_feedback` 一样不进 `meal_events`**：留痕事件流记的是**菜单的变化**（ADR-0007），
--   转正是菜谱库的变化，不是哪一餐的变化——挂进那个 append-only 流会让「这一餐吃了什么」
--   混进菜谱编辑的噪音。两张表各自回答一个问题。
-- * **不吃「生数据」纪律**：本文件只建表（规则资产层面的留痕形状），不种任何转正记录——
--   生数据（谁转过哪道菜）由真实使用产生，迁移里种一条等于伪造历史。
--   文件末只种 **#21 自己的一条待重标样张**（外部池的样张，与 004 同一类东西：
--   喂给转正路径与界面用的演示数据，不是「哪一餐吃了什么」这种生数据）——
--   它不动 004 的任何行，归属清楚（见文件末的说明）。
--
-- `member_id` 用 `ON DELETE SET NULL` 而不是 CASCADE：家人被删不该把「这道菜是谁转正的」
-- 一起抹掉（台账的价值在历史，不在外键完整性）。SQLite 需要这一列可空，所以没有 NOT NULL。

CREATE TABLE recipe_promotions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 菜谱行不删（退役也保留，历史要能查），所以是 RESTRICT 而不是 CASCADE
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  -- 转正发生的瞬间（注入时钟；测试可拨动）
  promoted_at TEXT NOT NULL,
  -- 谁点的转正（掌勺者，界面送当前身份）；家人被删后置 NULL，历史行留下
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- 掌勺者口述的差异原文（「多点辣、不放蒜」）；没口述就是空串（不是 NULL：这条记录说的是
  -- 「这次没提差异」，与「列不可用」是两件事）
  differences TEXT NOT NULL DEFAULT '',
  -- 菜系参考 tag 的前后值（掌勺者校对，总纲 §2.8）；没值就是 NULL（LLM 也没给、原来也没有）
  cuisine_from TEXT,
  cuisine_to   TEXT,
  -- LLM 调用元数据：转正**必须**由 LLM 改写（质量门槛），所以没有 degraded 位——
  -- 调用失败就没有这次转正（草稿留着让掌勺者重试），不存在「降级转正」这种状态。
  llm_model          TEXT,
  llm_prompt_version TEXT,
  llm_latency_ms     INTEGER,
  -- 三件套要么都空（不可能：转正必带调用），要么都齐——半份元数据没法解释
  CHECK ((llm_model IS NULL) = (llm_prompt_version IS NULL)
     AND (llm_model IS NULL) = (llm_latency_ms IS NULL))
);

-- 台账的读法：按菜谱看这道菜的编辑史（时间倒序）
CREATE INDEX idx_recipe_promotions_recipe ON recipe_promotions (recipe_id, promoted_at);

-- ---------------------------------------------------------------- 待重标样本（为「转正时先重标」这条路留真实数据）

-- 本票**自己的**一条待重标样本：
--
--   * #19 的导入器按设计会把「适量 / 少许」落成 0 克，报表里列成 `relabel.pending`；
--     但 004 的九道种子草稿**每一项都写了确切克数**——于是「待重标」这个状态在种子库里
--     一个样本也没有，而它恰恰是导入菜与家里确认过的菜最实质的差别之一（台账「归属 #19」
--     点名：#21 的掌勺者校对界面要把「待重标」标出来）。
--   * 为什么是**新增一条**而不是把 004 的某一道改一改：004 的种子是别的票刻意铺的
--     （含忌口样本、季节样本），改既有行会产生跨票影响，也违反本目录的「生数据只种样张、
--     不碰别人的行」这条纪律。样本要么像 004 那样是「一票自己的样张」，要么不动——
--     这条样本属于 #21，id 自报家门（`pending_relabel_*`）。所以本文件的其余部分照样
--     只建表、不种生数据。
--   * 形态照着真实导入数据：**主料**待重标（真实数据里 196/435 的待重标项是主料，
--     影响面最大那一类），其余项（土豆/姜/生抽）克数齐全——所以它是一个「部分待重标」的
--     真实形态，而不是整道菜没数。`source_quantity` 存采集到的原文（「适量」）当重标证据
--     （与 `llm/import-schema.ts` 的纪律 2 同一口径：模型看到的是原文，不是我们替它猜的数）。
--   * 它带 0 克项 → `hasPendingRelabel` 成立 → **不进推荐/换菜候选池**（迁移 005 的语义：
--     0 克乘进份量就是 0 g），与真实导入后未重标的草稿表现一致；转正时 LLM 必须把它
--     重标成正数（`llm/promotion-schema.ts` 的 `validateRewrite` 与 `domain/promotion.ts`
--     的事务一起守住："待重标 0 克" 与 "口述确认不放" 是两种语义，后者只在改写出参里存在，
--     落库时该项被丢掉——库里从不存「确认不放」）。
INSERT INTO recipes (id, name, kind, effort, status, source, steps) VALUES
  ('pending_relabel_ribs', '土豆炖排骨（待重标样本）', 'meat', 'medium', 'draft', 'howtocook',
   '排骨焯水炒糖色，下土豆块与姜片，加水小火炖 40 分钟，收汁加盐。');

INSERT INTO recipe_tastes (recipe_id, taste) VALUES
  ('pending_relabel_ribs', '咸鲜');

-- `adult_grams = 0` 只出现在主料那一项上：它是「模糊份量等 LLM 重标」，不是「不放排骨」
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor, source_quantity) VALUES
  ('pending_relabel_ribs', 'pork_ribs',        0,   0, 'linear', NULL, '适量'),
  ('pending_relabel_ribs', 'potato',           1, 150, 'linear', NULL, NULL),
  ('pending_relabel_ribs', 'ginger',           2,   5, 'fixed',  NULL, NULL),
  ('pending_relabel_ribs', 'light_soy_sauce',  3,  12, 'fixed',  NULL, NULL);
-- 不种任何转正记录：历史由真实使用产生。
