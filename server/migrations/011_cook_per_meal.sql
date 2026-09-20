-- 011_cook_per_meal.sql —— 掌勺者按**餐槽**指定（需求变更：掌勺者从全局标记 → 跟着每一餐走）
--
-- ## 为什么是「按餐」而不是「家人身上的标记」
--
-- `members.is_cook`（001）是**全局**标记：种子里妈妈 = 1，只在种子里定，运行期完全不可改。
-- 用户的原话是「掌勺者应该是随时可以改的」+「掌勺者会跟具体的某一餐绑在一起」——真实家庭里
-- 谁做哪一餐是逐顿决定的（爸爸今天做晚饭、妈妈明天做午饭），一个全局布尔表达不了。
--
-- 但 `is_cook` **不废掉**（本票的决议，理由写在 domain/members.ts 与台账）：
--   * 它是「家里通常谁做菜」的真实信息，`web/src/identity.tsx` 的「开 app 默认是谁」依赖它；
--   * 它是新餐槽掌勺者的**缺省值**——定餐界面不填时按家里的习惯走（本票同时把 is_cook 做成可改，
--     `ProfilePatch` 收它，家人页能勾选）。
--
-- ## 为什么落在 meal_events 上（而不是新开一张表）
--
-- ADR-0007：**没有可变的餐槽/菜单表**，当前状态由 append-only 的事件流折叠得出。掌勺者是
-- 「这一餐由谁做」，属于**菜单变化的一部分**——定餐/改餐时指定或改掉它，就该追加一条事件。
-- 这与 `leftover_menu_slot_id`（007 给同一张表后加的列）是同一个先例：给事件流**加列**，
-- 不重建表（002 的 `meal_events_no_update`/`no_delete` 触发器让 UPDATE/DELETE 都非法，
-- `ALTER TABLE ADD COLUMN` 是唯一合法的 schema 变更方式）。
--
-- ## 快照列：记「当时的谁」，不回头查
--
-- `cook_member_id` 指向的是**那一次定餐时的家人**，而家人可以被软删除（010）。留痕的价值是
-- 「当时是谁」，不是「现在这个人还在不在」——所以照 `meal_event_diners` 的既有做法，把当时的
-- 姓名与头像一起固化成快照（`cook_member_name` / `cook_member_emoji`）。
-- 三个列**要么都空（这一餐没指定掌勺者），要么都齐**：半份快照没法解释（半个掌勺者是谁？）。
-- 软删除的家人仍能在历史/当前折叠里读出当时的名字——不留一个会显示 undefined 的洞。
--
-- 与 `meal_event_diners.member_id` 一样**不建外键**：外键会阻止软删除（其实软删除只打
-- `deleted_at`、不删行，本可外键），但更根本的是——留痕是不可改写的历史，历史里的「当时的谁」
-- 不该被 members 表的未来变化约束；新人复用 id 之类的手改数据也不该让历史变红。
-- 校验写在领域层（`slots.ts` 的 `resolveCook`：只认在用家人）。
--
-- ⚠️ SQLite 的 `ALTER TABLE ADD COLUMN` 限制：不能加「非空且无默认值」的列。三列都可空，天然满足。
-- 跨列 CHECK 引用的是**先加的列**（SQLite 只允许 ADD COLUMN 的 CHECK 引用已存在的列），
-- 所以 `cook_member_id` 先加，另两列的 CHECK 引它。

ALTER TABLE meal_events ADD COLUMN cook_member_id TEXT;
-- 当时的姓名/头像快照；与 cook_member_id 同生共死（见文件头）
ALTER TABLE meal_events ADD COLUMN cook_member_name TEXT
  CHECK ((cook_member_name IS NULL) = (cook_member_id IS NULL));
ALTER TABLE meal_events ADD COLUMN cook_member_emoji TEXT
  CHECK ((cook_member_emoji IS NULL) = (cook_member_id IS NULL));

-- 不建索引：读路径是「按 slot_id 取事件、折叠出当前掌勺者」，`idx_meal_events_slot`
-- （002）已经覆盖；没有「按掌勺者反查餐次」的需求。
