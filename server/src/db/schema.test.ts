import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 001 的数据完整性约束（食材字典 + 家人画像）。
 *
 * 总纲 Testing Decisions 要求「只断言外部可见行为……不断言表结构」。这里**刻意只留**
 * 当前没有任何 HTTP 通道可及的几条（别名唯一、爱吃恰好指向一个目标、级联删除、食材删除级联），
 * 其余已由 api/members.test.ts 与 api/ingredients.test.ts 走 HTTP 覆盖，不在此重复：
 *   * 小孩必有出生年月 → `birth_month_required`
 *   * 出生年月格式 → `invalid_birth_month`
 *   * 清单去重 → 画像编辑的「重复条目只留一条」
 *
 * 留这几条的理由：它们是**受控表的引用完整性**，本票没有任何写入口能触及（别名与
 * recipe_id 都由迁移写入），级联更只在删数据时发生。等 #15 引入菜谱表与字典维护接口后，
 * 这些约束会出现 HTTP 通道，届时把它们搬过去、删掉本文件。
 */
describe('001 迁移的引用完整性', () => {
  it('别名全局唯一：一个叫法只能指向一个食材，归一不在源头分叉', () => {
    harness = createTestHarness();

    expect(() =>
      harness.db
        .prepare("INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ('potato', '西红柿')")
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('爱吃条目恰好指向一个目标：食材或具体菜，不能都填、不能都不填', () => {
    harness = createTestHarness();
    const insert = (ingredientId: string | null, recipeId: string | null): void => {
      harness.db
        .prepare('INSERT INTO member_loves (member_id, ingredient_id, recipe_id, created_at) VALUES (?, ?, ?, ?)')
        .run('mom', ingredientId, recipeId, '2025-01-01T00:00:00Z');
    };

    // 同一家人的同一食材不重复入库（清单是集合）
    insert('tofu', null);
    expect(() => insert('tofu', null)).toThrow(/UNIQUE/);
    // 两个都填 / 都不填：语义不明，拒绝
    expect(() => insert('corn', 'hongshaopaigu')).toThrow(/CHECK/);
    expect(() => insert(null, null)).toThrow(/CHECK/);
    // 002 给 recipe_id 补了外键：菜粒度条目不能指向不存在的菜
    expect(() => insert(null, '还没做的菜')).toThrow(/FOREIGN KEY/);
  });

  it('删掉家人时画像条目跟着走（不留指向空处的忌口）', () => {
    harness = createTestHarness();

    harness.db.prepare("DELETE FROM members WHERE id = 'xiaobao'").run();

    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM member_avoid WHERE member_id = 'xiaobao'").get()).toEqual({
      n: 0,
    });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM member_loves WHERE member_id = 'xiaobao'").get()).toEqual({
      n: 0,
    });
  });

  it('食材字典是受控表：删掉食材时别名跟着走', () => {
    harness = createTestHarness();

    // 用一个没人引用的食材：先自己建一个，避开种子里已被画像引用的那些
    harness.db.prepare("INSERT INTO ingredients (id, name) VALUES ('probe_ing', '探针食材')").run();
    harness.db.prepare("INSERT INTO ingredient_aliases (ingredient_id, alias) VALUES ('probe_ing', '探针叫法')").run();

    harness.db.prepare("DELETE FROM ingredients WHERE id = 'probe_ing'").run();

    expect(
      harness.db.prepare("SELECT COUNT(*) AS n FROM ingredient_aliases WHERE ingredient_id = 'probe_ing'").get(),
    ).toEqual({ n: 0 });
  });

  it('正在被画像引用的食材不能被删（字典是全库唯一受控表，不允许留下悬空条目）', () => {
    harness = createTestHarness();

    // 番茄在大宝的爱吃里（种子）——删它必须被拦下，否则画像就出现指向空处的条目
    expect(() => harness.db.prepare("DELETE FROM ingredients WHERE id = 'tomato'").run()).toThrow(
      /FOREIGN KEY/,
    );

    // 更彻底地说：整库自检不该有悬空引用（PRAGMA 是 SQLite 自己的检查，不是我们的断言）
    expect(harness.db.pragma('foreign_key_check')).toEqual([]);
  });
});
