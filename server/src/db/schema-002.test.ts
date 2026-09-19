import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 002 的数据完整性约束（菜谱 + 留痕事件流）。
 *
 * 与 schema.test.ts 同一口径：**只断言外部可见行为**，这里只留当前没有任何 HTTP 通道
 * 或 HTTP 通道不该管的那几条（受控表引用完整性、append-only 触发器）。菜谱的荤素位枚举、
 * 状态机、忌口推导等已由 api/recipes.test.ts 与 api/slots.test.ts 走 HTTP 覆盖，不在此重复。
 *
 * 留这几条的理由：**append-only 是 ADR-0007 的核心承诺**，而“不可改写”在 HTTP 层看不出
 * 差别（没人会去改历史）——它的护栏就在数据库上。这类“没人能通过接口触发”的约束，
 * 只能在这里探针式地验一次。
 */
describe('002 迁移的引用完整性与 append-only 触发', () => {
  it('菜谱食材指向字典里不存在的食材被拒（字典是全库唯一受控表）', () => {
    harness = createTestHarness();

    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO recipe_ingredients (recipe_id, ingredient_id, position, adult_grams) VALUES ('fanqiechaodan', '巧克力', 9, 10)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('隐性忌口「含」指针不能指向自己（自引用校验）', () => {
    harness = createTestHarness();

    expect(() =>
      harness.db
        .prepare("INSERT INTO ingredient_contains (ingredient_id, contains_id) VALUES ('oyster_sauce', 'oyster_sauce')")
        .run(),
    ).toThrow(/CHECK/);
    // 指向字典外的食材同样被拒（指针的两头都是受控表的行）
    expect(() =>
      harness.db
        .prepare("INSERT INTO ingredient_contains (ingredient_id, contains_id) VALUES ('oyster_sauce', '巧克力')")
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('留痕事件不可改写、不可删除（append-only 是 ADR-0007 的核心承诺）', async () => {
    harness = createTestHarness();
    const { status } = await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'fanqiechaodan' }] }),
    });
    expect(status).toBe(200);

    const seq = (harness.db.prepare('SELECT MAX(seq) AS seq FROM meal_events').get() as { seq: number }).seq;
    // 改写：菜单历史一旦可改，「为什么推这道 / 为什么没推」就失去回溯能力
    expect(() => harness.db.prepare("UPDATE meal_events SET type = 'cancel' WHERE seq = ?").run(seq)).toThrow(
      /append-only/,
    );
    // 删除：历史不是可裁剪的日志
    expect(() => harness.db.prepare('DELETE FROM meal_events WHERE seq = ?').run(seq)).toThrow(/append-only/);
    // 子表（用餐者/菜品快照）同样只管追加
    expect(() => harness.db.prepare('UPDATE meal_event_dishes SET keep_leftover = 1 WHERE seq = ?').run(seq)).toThrow(
      /append-only/,
    );
    expect(() => harness.db.prepare('DELETE FROM meal_event_diners WHERE seq = ?').run(seq)).toThrow(/append-only/);
  });

  it('被历史引用过的菜谱删不掉，退役行保留（退役不是删除）', async () => {
    harness = createTestHarness();
    await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'fanqiechaodan' }] }),
    });

    expect(() => harness.db.prepare("DELETE FROM recipes WHERE id = 'fanqiechaodan'").run()).toThrow(/FOREIGN KEY/);
    // 退役是状态改写而不是删行：改写后菜谱行还在（历史引用它时还能读出来）
    harness.db.prepare("UPDATE recipes SET status = 'retired' WHERE id = 'fanqiechaodan'").run();
    expect(harness.db.prepare("SELECT status FROM recipes WHERE id = 'fanqiechaodan'").get()).toEqual({
      status: 'retired',
    });
  });

  it('整库自检没有悬空引用（PRAGMA 是 SQLite 自己的检查）', async () => {
    harness = createTestHarness();
    await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom', 'dabao'], dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }] }),
    });

    expect(harness.db.pragma('foreign_key_check')).toEqual([]);
  });
});
