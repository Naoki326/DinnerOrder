import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 011 的数据完整性约束（掌勺者按餐指定）。
 *
 * 与 schema.test.ts / schema-002.test.ts 同一口径：**只断言外部可见行为**。
 * HTTP 通道覆盖了绝大多数（slots.test.ts 的「掌勺者按餐指定」一组建餐/改餐/回落/软删除），
 * 这里只留 HTTP 层**碰不到**的那一条：掌勺者快照三列必须同生共死。
 *
 * 为什么它碰不到：领域层的 `resolveCook` 永远同时给三列或都不给（`insertEvent` 的
 * `event.cook?.x ?? null`），所以经接口根本写不出半份快照。跨列 CHECK 是数据库替我们看门，
 * 防止的是「后来有人手写 SQL / 加了新写入口却漏了一列」——那种情况下半份快照（知道是谁的 id，
 * 却显示不出名字）会在界面上变成一个 undefined 的洞，而那正是本票特意要避免的东西。
 */
describe('011 迁移的掌勺者快照约束', () => {
  it('掌勺者姓名/头像与 id 同生共死：半份快照被 CHECK 拒收', () => {
    harness = createTestHarness();

    // 先写一条合法事件（都空：这一餐没指定掌勺者），取它的 seq 与列
    expect(() =>
      harness.db
        .prepare(
          `INSERT INTO meal_events (slot_id, slot_date, meal, type, source, occurred_at)
           VALUES ('2025-06-01:dinner', '2025-06-01', 'dinner', 'decide', 'manual', '2025-06-01T00:00:00Z')`,
        )
        .run(),
    ).not.toThrow();

    const insert = (id: string | null, name: string | null, emoji: string | null): void => {
      harness.db
        .prepare(
          `INSERT INTO meal_events
             (slot_id, slot_date, meal, type, source, occurred_at,
              cook_member_id, cook_member_name, cook_member_emoji)
           VALUES ('2025-06-01:lunch', '2025-06-01', 'lunch', 'decide', 'manual', '2025-06-01T00:00:00Z', ?, ?, ?)`,
        )
        .run(id, name, emoji);
    };

    // 有 id 没名字 / 有名字没 id：半份快照都不合法（界面读不出完整的人）
    expect(() => insert('mom', null, null)).toThrow(/CHECK/);
    expect(() => insert(null, '妈妈', '👩')).toThrow(/CHECK/);
    expect(() => insert('mom', '妈妈', null)).toThrow(/CHECK/);
    // 三列全空（没指定）/ 三列全齐（指定了）都是合法状态
    expect(() => insert(null, null, null)).not.toThrow();
    expect(() => insert('mom', '妈妈', '👩')).not.toThrow();
  });
});
