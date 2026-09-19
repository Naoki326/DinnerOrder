# 迁移（migrations）

`server/migrations/` 下按 `<三位版本号>_<描述>.sql` 命名（如 `001_init.sql`），启动时由 `src/db/migrate.ts`
按版本号升序执行，已执行的记录在 `schema_migrations` 表；每个文件一个事务，失败回滚后下次启动重试。

- 不要修改已执行过的迁移文件，追加新编号即可（append-only 的 schema 历史）。
- 本目录在 M1-01（#13）刻意为空：骨架票不发明领域表，餐槽/菜单/菜谱等表由各自的工单迁移进来。
- 执行器自身的行为由 `src/db/migrate.test.ts`（临时目录 fixture）覆盖，不依赖本目录内容。
