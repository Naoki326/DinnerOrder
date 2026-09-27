import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { pickLlmSelection } from '../llm/prompt.js';
import { pickPromotionRewrite } from '../llm/promotion-schema.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 014 的**迁移纪律**（菜谱修订台账，issue #30）。
 *
 * 与 schema-008.test.ts / schema-013.test.ts 同一口径：只断言外部可见行为，把行为测试留给
 * `api/recipe-library.test.ts`。这里钉的是三条**表自身的纪律**（行为测试不该碰的）：
 *   1. **不种生数据**：迁移只建表，`recipe_edits` 在全新库上必须是空的；
 *   2. **与 `recipe_promotions` 并立、不混表**：两张表各自的列语义不同；
 *   3. **`changed_fields` 有非空 CHECK**：一次「什么都没改」的提交不该写台账。
 */
describe('014 迁移的修订台账纪律', () => {
  it('迁移只建表、不种生数据：全新库上台账是空的', () => {
    harness = createTestHarness();

    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_edits').get() as { n: number }).n).toBe(0);
    // 转正台账同样（008 的既有纪律）
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_promotions').get() as { n: number }).n).toBe(0);
  });

  it('与转正台账并立、不混表：两张表各自回答一个问题', () => {
    harness = createTestHarness();

    const columnsOf = (table: string): string[] =>
      (harness.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name).sort();

    // 修订台账：字段级（changed_fields），没有转正专属那几列
    expect(columnsOf('recipe_edits')).toEqual(['changed_fields', 'edited_at', 'id', 'member_id', 'recipe_id']);
    // 转正台账：口述差异 + 菜系前后 + LLM 三件套（本票一列没动它）
    expect(columnsOf('recipe_promotions')).toContain('differences');
    expect(columnsOf('recipe_promotions')).toContain('cuisine_from');
    expect(columnsOf('recipe_promotions')).toContain('llm_prompt_version');
    expect(columnsOf('recipe_promotions')).not.toContain('changed_fields');
  });

  it('changed_fields 有非空 CHECK：数据库不认「一次什么都没改」的台账行', () => {
    harness = createTestHarness();

    expect(() =>
      harness.db
        .prepare(`INSERT INTO recipe_edits (recipe_id, edited_at, member_id, changed_fields) VALUES (?, ?, NULL, '')`)
        .run('fanqiechaodan', '2025-06-01T10:00:00.000Z'),
    ).toThrow(/CHECK/i);
  });

  it('member_id 是 ON DELETE SET NULL：家人被删，台账行留下', () => {
    harness = createTestHarness();

    harness.db
      .prepare(`INSERT INTO recipe_edits (recipe_id, edited_at, member_id, changed_fields) VALUES (?, ?, ?, ?)`)
      .run('fanqiechaodan', '2025-06-01T10:00:00.000Z', 'dad', 'steps');

    // 硬删家人（生产走软删，但外键语义本身要经得起硬删的考验）
    harness.db.prepare('DELETE FROM members WHERE id = ?').run('dad');

    const row = harness.db
      .prepare('SELECT member_id, changed_fields FROM recipe_edits WHERE recipe_id = ?')
      .get('fanqiechaodan') as { member_id: string | null; changed_fields: string };
    expect(row.member_id).toBeNull();
    expect(row.changed_fields).toBe('steps');
  });

  it('菜谱行是 RESTRICT：被台账引用过的菜谱删不掉（历史要能查）', () => {
    harness = createTestHarness();

    harness.db
      .prepare(`INSERT INTO recipe_edits (recipe_id, edited_at, member_id, changed_fields) VALUES (?, ?, NULL, ?)`)
      .run('fanqiechaodan', '2025-06-01T10:00:00.000Z', 'steps');

    expect(() => harness.db.prepare('DELETE FROM recipes WHERE id = ?').run('fanqiechaodan')).toThrow(/FOREIGN KEY/i);
  });

  it('修订与转正是两条独立的台账：一次转正不写修订表，一次修订不写转正表', async () => {
    harness = createTestHarness();
    harness.llm.setCompletion(
      (request) => pickPromotionRewrite(request.prompt) ?? pickLlmSelection(request.prompt) ?? '{"dishes":[]}',
    );

    // 转正一道草稿（走真实的转正路径）
    await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'xiangguhuaji' }] }),
    });
    harness.clock.set('2025-06-02T10:00:00.000Z');
    const promoted = await harness.json('/api/recipes/xiangguhuaji/promotion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: 'mom' }),
    });
    expect(promoted.status).toBe(200);

    // 转正写的是 promotion 表，修订表仍是空的
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_promotions').get() as { n: number }).n).toBe(1);
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_edits').get() as { n: number }).n).toBe(0);

    // 再修订一次：修订表 +1，转正表不变
    await harness.json('/api/recipes/xiangguhuaji', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps: '改了。' }),
    });
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_edits').get() as { n: number }).n).toBe(1);
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_promotions').get() as { n: number }).n).toBe(1);
  });
});
