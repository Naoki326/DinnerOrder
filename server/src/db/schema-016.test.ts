import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 016 的**迁移纪律**（食材变更台账，issue #35）。
 *
 * 与 schema-014.test.ts（菜谱修订台账）同一口径：只断言**表自身的纪律**，把行为测试留给
 * `api/ingredients.test.ts`。这里钉的是四条行为测试不该碰的：
 *   1. **不种生数据**：迁移只建表，`ingredient_edits` 在全新库上必须是空的；
 *   2. **与 `recipe_edits` 并立、不混表**：两张表各自的列语义不同（一个指菜谱、一个指食材）；
 *   3. **`changed_fields` 有非空 CHECK**：一次「什么都没改」的提交不该写台账；
 *   4. **指 `ingredients` 是 `ON DELETE CASCADE`**：台账**不算一类引用**、不阻挡删除，
 *      删除时随食材一起走（与 014 指 `recipes` 的 RESTRICT 有意不同，见 ADR-0012 修订注）。
 */
describe('016 迁移的食材变更台账纪律', () => {
  it('迁移只建表、不种生数据：全新库上台账是空的', () => {
    harness = createTestHarness();

    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM ingredient_edits').get() as { n: number }).n).toBe(0);
    // 菜谱修订台账同样（014 的既有纪律）——两张表各自独立
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_edits').get() as { n: number }).n).toBe(0);
  });

  it('与菜谱修订台账并立、不混表：两张表各自指向自己的实体', () => {
    harness = createTestHarness();

    const columnsOf = (table: string): string[] =>
      (harness.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name).sort();

    // 食材台账：指 ingredient_id / changed_at（形状与 014 同构，但列名跟着本实体走）
    expect(columnsOf('ingredient_edits')).toEqual(['changed_at', 'changed_fields', 'id', 'ingredient_id', 'member_id']);
    // 菜谱台账刻的是 014 的字形（本票一列没动它）
    expect(columnsOf('recipe_edits')).toEqual(['changed_fields', 'edited_at', 'id', 'member_id', 'recipe_id']);
  });

  it('changed_fields 有非空 CHECK：数据库不认「一次什么都没改」的台账行', () => {
    harness = createTestHarness();

    expect(() =>
      harness.db
        .prepare(`INSERT INTO ingredient_edits (ingredient_id, changed_at, member_id, changed_fields) VALUES (?, ?, NULL, '')`)
        .run('tomato', '2025-06-01T10:00:00.000Z'),
    ).toThrow(/CHECK/i);
  });

  it('member_id 是 ON DELETE SET NULL：家人被删，台账行留下', () => {
    harness = createTestHarness();

    harness.db
      .prepare(`INSERT INTO ingredient_edits (ingredient_id, changed_at, member_id, changed_fields) VALUES (?, ?, ?, ?)`)
      .run('tomato', '2025-06-01T10:00:00.000Z', 'dad', 'name');

    // 硬删家人（生产走软删，但外键语义本身要经得起硬删的考验）
    harness.db.prepare('DELETE FROM members WHERE id = ?').run('dad');

    const row = harness.db
      .prepare('SELECT member_id, changed_fields FROM ingredient_edits WHERE ingredient_id = ?')
      .get('tomato') as { member_id: string | null; changed_fields: string };
    expect(row.member_id).toBeNull();
    expect(row.changed_fields).toBe('name');
  });

  it('食材被删时台账随它一起走：CASCADE 而不是 RESTRICT（删除只由「有人用它」决定）', () => {
    harness = createTestHarness();

    // 自建一条零引用的条目（不去碰被种子引用的 tomato）
    harness.db.prepare('INSERT INTO ingredients (id, name) VALUES (?, ?)').run('tmp_cascade', '临时的');
    harness.db
      .prepare(`INSERT INTO ingredient_edits (ingredient_id, changed_at, member_id, changed_fields) VALUES (?, ?, NULL, ?)`)
      .run('tmp_cascade', '2025-06-01T10:00:00.000Z', 'name');

    // 零引用 → 删得掉（台账不阻挡），且台账行随它一起走
    harness.db.prepare('DELETE FROM ingredients WHERE id = ?').run('tmp_cascade');

    expect(
      (harness.db
        .prepare('SELECT COUNT(*) AS n FROM ingredient_edits WHERE ingredient_id = ?')
        .get('tmp_cascade') as { n: number }).n,
    ).toBe(0);
  });
});
