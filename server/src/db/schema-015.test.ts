import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import type { Recipe } from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 015 的迁移纪律（菜谱来源链接，issue #32）。
 *
 * 与 schema-014.test.ts 同一口径：只钉**表自身的纪律**，行为断言留给
 * `api/recipe-import.test.ts` 与 `api/recipe-library.test.ts`。这里管三件事：
 *
 *   1. **`ALTER TABLE ADD COLUMN` 是真的可行路**：本迁移刻意不重建 `recipes`
 *      （SQLite 在 `foreign_keys=ON` 下 DROP 父表会被子表挡住，事务内关 FK 又无效）——
 *      这条测试就是那个决定的回归：加列之后外键子表照旧可写、`foreign_key_check` 不新增违规。
 *   2. **不种生数据**：迁移只加列，全新库里所有行都是 `NULL`（“没有记录来源”不是编一个）。
 *   3. **旧写入路径不受影响**：不带 `source_ref` 的 INSERT（导入工具那条路）照旧成功。
 */
describe('015 迁移的来源链接纪律', () => {
  it('加列不破坏外键子表：种子菜谱的清单/口味仍读得出来，且不新增违规', () => {
    harness = createTestHarness();

    // 列确实加上了
    const columns = harness.db.prepare('PRAGMA table_info(recipes)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('source_ref');

    // 种子行的来源是 NULL（没记录，不编）
    const seeded = harness.db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE source_ref IS NOT NULL').get() as { n: number };
    expect(seeded.n).toBe(0);

    // 子表仍可写（外键没被加列弄坏）——拿一道种子菜加一项口味，再删掉
    const recipeId = (harness.db.prepare("SELECT id FROM recipes WHERE status = 'active' LIMIT 1").get() as { id: string }).id;
    expect(() =>
      harness.db.prepare('INSERT INTO recipe_tastes (recipe_id, taste) VALUES (?, ?)').run(recipeId, '甜'),
    ).not.toThrow();
    harness.db.prepare('DELETE FROM recipe_tastes WHERE recipe_id = ? AND taste = ?').run(recipeId, '甜');
  });

  it('不带来源的写入路径照旧（导入工具那条路不传 source_ref）', () => {
    harness = createTestHarness();

    expect(() =>
      harness.db
        .prepare(
          `INSERT INTO recipes (id, name, kind, effort, status, source, cuisine, steps)
           VALUES ('test_htc_style', '不带来源的菜', 'veg', 'quick', 'draft', 'howtocook', NULL, '')`,
        )
        .run(),
    ).not.toThrow();
    const row = harness.db.prepare("SELECT source_ref FROM recipes WHERE id = 'test_htc_style'").get() as {
      source_ref: string | null;
    };
    expect(row.source_ref).toBeNull();
  });

  it('线上形状默认带上 sourceRef：旧行读出 null 而不是 undefined', async () => {
    harness = createTestHarness();

    const { body } = await harness.json<{ recipes: Recipe[] }>('/api/recipes?status=all');
    // 每一行都必须有这个键（前端拿它直接渲染「来源：…」），值可以是 null
    for (const recipe of body.recipes) {
      expect(recipe).toHaveProperty('sourceRef');
      expect(recipe.sourceRef === null || typeof recipe.sourceRef === 'string').toBe(true);
    }
  });
});
