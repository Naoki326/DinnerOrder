-- M1-15 菜谱库：掌勺者可写（录入/修订/退役）（issue #30；ADR-0009）
--
-- 本文件只建一张**修订台账**表 `recipe_edits`，不种任何生数据（谁改了哪道菜由真实使用产生）。
--
-- * **为什么不塞进 `recipe_promotions`**：那张表的列名（`cuisine_from` / `cuisine_to`、LLM 三件套）
--   全是**转正专属语义**，而 ADR-0006 的核心门槛判定的正是那张表。混表会让门槛越来越难读
--   （「这一行是转正还是改菜名？」要逐列猜）。两张表各自回答一个问题：
--   `recipe_promotions` 回答「这道菜是怎么从外部变成家里的」，`recipe_edits` 回答「这道菜最近被改成什么样」。
-- * **粒度是字段级，不是食材级 diff**：`changed_fields` 是逗号分隔的字段名（如 `name,steps,ingredients`），
--   能回答「改了做法」就够了。食材级 diff（哪一项克数从多少改到多少）要另立设计，本票不做（Out of Scope）。
-- * **`member_id` 用 `ON DELETE SET NULL`**：与 `recipe_promotions` 同形——家人被删不该把
--   「这道菜是谁改的」一起抹掉，台账的价值在历史，不在外键完整性。
-- * **`changed_fields` 存逗号分隔的字符串而不是一张子表**：它是一行的**描述**（这一次改了哪几块），
--   不是一个会被单独查询的实体。要按字段查（「谁改过 steps」）时的规模也远在一个家庭库的
--   量级之内（LIKE 扫得动）；拆表换来的是每次写入多 N 行与一次 join，不值得。
-- * 与 `recipe_promotions` 一样**不进 `meal_events`**（ADR-0007）：留痕事件流记的是菜单的变化，
--   菜谱编辑是菜谱库的变化。两张表各自回答一个问题。

CREATE TABLE recipe_edits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 菜谱行不删（退役也保留，历史要能查），所以是 RESTRICT 而不是 CASCADE
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  -- 修订发生的瞬间（注入时钟；测试可拨动）
  edited_at TEXT NOT NULL,
  -- 谁改的（掌勺者，界面送当前身份）；家人被删后置 NULL，历史行留下
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- 这一次改了哪几个字段（字段名，逗号分隔，如 'name,steps,ingredients'）。
  -- 空串是**不允许**的：一次「什么都没改」的提交不该写台账（服务端在领域层拦下）。
  changed_fields TEXT NOT NULL CHECK (changed_fields <> '')
);

-- 台账的读法：按菜谱看这道菜的修订史（时间倒序）
CREATE INDEX idx_recipe_edits_recipe ON recipe_edits (recipe_id, edited_at);
