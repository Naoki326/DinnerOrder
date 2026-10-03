-- M1-16 食材字典：改食材（issue #35；ADR-0012）
--
-- 本文件只建一张**变更台账**表 `ingredient_edits`，不种任何生数据（谁把哪条食材改成什么由真实使用产生）。
--
-- * **与 `recipe_edits`（014）同构**：两件事的回答形状一样——`recipe_edits` 回答「这道菜最近被
--   改成什么样」，`ingredient_edits` 回答「这条食材最近被改成什么样」。改的是**内容**，
--   不是这条食材从哪来（与 `CONTEXT.md`「改食材」词条对「录入食材」的区分同构）。
-- * **粒度是字段级，不是别名级 diff**：`changed_fields` 是逗号分隔的字段名（如 `name,aliases`），
--   能回答「改了名字与别名」就够了。逐条 diff（哪个别名从什么改成什么）不属于本票。
-- * **`changed_fields` 存逗号分隔的字符串而不是一张子表**：它是**一次改动改了哪几块**的描述，
--   不是一个会被单独查询的实体。与 `recipe_edits` 同一理由（那条注释写得更全）。
-- * **`member_id` 用 `ON DELETE SET NULL`**：与 `recipe_edits` / `recipe_promotions` 同形——
--   家人被删不该把「这条食材是谁改的」一起抹掉，台账的价值在历史，不在外键完整性。
-- * **指 `ingredients` 是 `ON DELETE CASCADE`**（与 `recipe_edits` 指 `recipes` 的默认 RESTRICT
--   **有意不同**，见 ADR-0012「决定四」的修订注）：台账**不算一类「引用」**。
--   删除的判据只有一条——**有没有人用它**（被菜谱/忌口/爱吃/生熟互换/买菜清单引用，
--   或作为另一条食材的「含」指针目标）；而「改过」是来路，不是用途。
--   使用 `RESTRICT` 会让「改过一次的食材永久删不掉」，直接顶撞 Story 32（错别字条目不该永久留下）
--   与 Story 35（删掉后名字能被重新使用），也会让 `CONTEXT.md` / `README.md` /
--   本 ADR 三处「6 处引用」的权威口径自相矛盾。`CASCADE` 的代价（删条目会带走它的改写史）可控：
--   真要留下的历史，那 6 处被引用的食材本来就删不掉，它们的台账照样在。
-- * **不进 `meal_events`**（ADR-0007）：留痕事件流记的是菜单的变化，食材编辑是字典的变化。

CREATE TABLE ingredient_edits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 食材被删时台账一并带走（它**不算**一类引用，不阻挡删除；见上面 CASCADE 那一段）
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  -- 改动发生的瞬间（注入时钟；测试可拨动）
  changed_at TEXT NOT NULL,
  -- 谁改的（界面送当前身份）；家人被删后置 NULL，历史行留下
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  -- 这一次改了哪几个字段（字段名，逗号分隔，如 'name,aliases,seasonMonths,contains'）。
  -- 空串是**不允许**的：一次「什么都没改」的提交不该写台账（服务端在领域层拦下，报 409）。
  changed_fields TEXT NOT NULL CHECK (changed_fields <> '')
);

-- 台账的读法：按食材看这条的改写史（时间倒序）
CREATE INDEX idx_ingredient_edits_ingredient ON ingredient_edits (ingredient_id, changed_at);
