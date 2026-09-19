# 迁移（migrations）

`server/migrations/` 下按 `<三位版本号>_<描述>.sql` 命名（如 `001_members_and_ingredients.sql`），启动时由
`src/db/migrate.ts` 按版本号升序执行，已执行的记录在 `schema_migrations` 表；每个文件一个事务，失败回滚后下次启动重试。

- 不要修改已执行过的迁移文件，追加新编号即可（append-only 的 schema 历史）。
- 现有版本：
  - `001_members_and_ingredients` —— 食材字典（规范名 + 别名）与家人画像（大人/小孩、性别、出生年月、忌口、爱吃），
    含本家常用食材与真实家人种子（M1-02 / #14）。
- 种子数据写在迁移里（而不是启动时补种），这样测试 harness、E2E 的文件库、生产库三条路径拿到的是同一份初值。
- 执行器自身的行为由 `src/db/migrate.test.ts`（临时目录 fixture）覆盖；本目录内容由 `src/db/schema.test.ts` 与
  各 API 集成测试覆盖。
