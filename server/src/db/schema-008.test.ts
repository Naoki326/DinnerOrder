import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 008 的引用完整性与约束（转正台账）。
 *
 * 与 schema.test.ts / schema-002.test.ts 同一口径：**只断言外部可见行为**。台账的写入路径
 * （谁在什么时候按谁的口述改成了什么）由 `api/promotion.test.ts` 走 HTTP 覆盖，不在此重复。
 * 留在这里的是**没有任何写入口能触及**的那几条：家人被删时台账行的归属变化、菜谱被引用后
 * 不能删、LLM 元数据三件套的「全有或全无」。
 *
 * 为什么这几条重要：台账的全部价值是「这道菜为什么长成了家里这一版」的历史——
 * 随着家人删除而消失（CASCADE）或留下半份元数据，都让这段历史说不清。
 *
 * 另加一条**本票自己的待重标样张**的迁移纪律（008 末尾的那条样张）：它必须是一条**新菜**，
 * 而不是对 004 种子行的 UPDATE——改别人的行会产生跨票影响（那是 `migrations/README.md`
 * 的「生数据」纪律）。所以下面同时钉住「新样张确实种下了」与「004 的家常豆腐没被碰」。
 */
describe('008 迁移的引用完整性与元数据约束', () => {
  it('删掉家人后台账行留下，只是归属置空（历史不该随人消失）', () => {
    harness = createTestHarness();
    const insert = harness.db.prepare(
      `INSERT INTO recipe_promotions (recipe_id, promoted_at, member_id, differences, llm_model, llm_prompt_version, llm_latency_ms)
       VALUES ('qingchaodouya', '2025-06-02T10:00:00.000Z', 'dabao', '不放蒜', 'm', 'v1', 120)`,
    );
    insert.run();

    harness.db.prepare("DELETE FROM members WHERE id = 'dabao'").run();

    const row = harness.db
      .prepare("SELECT member_id, differences FROM recipe_promotions WHERE recipe_id = 'qingchaodouya'")
      .get() as { member_id: string | null; differences: string } | undefined;
    // 行还在、口述差异还在；只是「谁点的」变成未知（SET NULL，不是 CASCADE）
    expect(row).toBeDefined();
    expect(row!.member_id).toBeNull();
    expect(row!.differences).toBe('不放蒜');
  });

  it('台账不能指向不存在的菜谱（菜谱行不删，退役也保留）', () => {
    harness = createTestHarness();
    expect(() =>
      harness.db
        .prepare(
          `INSERT INTO recipe_promotions (recipe_id, promoted_at, differences, llm_model, llm_prompt_version, llm_latency_ms)
           VALUES ('meiyouzhedaocai', '2025-06-02T10:00:00.000Z', '', 'm', 'v1', 100)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('被台账引用过的菜谱删不掉（历史留痕指着它）', () => {
    harness = createTestHarness();
    harness.db
      .prepare(
        `INSERT INTO recipe_promotions (recipe_id, promoted_at, differences, llm_model, llm_prompt_version, llm_latency_ms)
         VALUES ('qingchaodouya', '2025-06-02T10:00:00.000Z', '', 'm', 'v1', 100)`,
      )
      .run();

    expect(() => harness.db.prepare("DELETE FROM recipes WHERE id = 'qingchaodouya'").run()).toThrow(/FOREIGN KEY/);
  });

  it('LLM 元数据三件套全有或全无（半份元数据没法解释）', () => {
    harness = createTestHarness();
    const run = (model: string | null, version: string | null, latency: number | null): void => {
      harness.db
        .prepare(
          `INSERT INTO recipe_promotions (recipe_id, promoted_at, differences, llm_model, llm_prompt_version, llm_latency_ms)
           VALUES ('qingchaodouya', '2025-06-02T10:00:00.000Z', '', ?, ?, ?)`,
        )
        .run(model, version, latency);
    };

    // 缺一项就拒（三种缺法各试一次）
    expect(() => run('m', 'v1', null)).toThrow(/CHECK/);
    expect(() => run('m', null, 100)).toThrow(/CHECK/);
    expect(() => run(null, 'v1', 100)).toThrow(/CHECK/);
    // 全空是合法形状（形状上允许，实际路径上转正必带调用——见 008 文件头的说明）
    run(null, null, null);
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM recipe_promotions').get()).toEqual({ n: 1 });
  });

  it('迁移 008 落进 schema_migrations（版本号与执行器对得上）', () => {
    harness = createTestHarness();
    const row = harness.db.prepare("SELECT name FROM schema_migrations WHERE version = '008'").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('recipe_promotions');
  });

  it('待重标样张是本票自己的新菜：主料 0 克 + 原文证据，其余项克数齐全', () => {
    harness = createTestHarness();

    const rows = harness.db
      .prepare(
        `SELECT ri.adult_grams AS grams, ri.source_quantity AS quantity, i.name AS ingredient
           FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
          WHERE ri.recipe_id = 'pending_relabel_ribs' ORDER BY ri.position`,
      )
      .all() as { grams: number; quantity: string | null; ingredient: string }[];

    expect(rows.map((row) => row.ingredient)).toEqual(['猪排骨', '土豆', '姜', '生抽']);
    // 主料待重标：0 = 模糊份量等 LLM 重标（迁移 005），原文「适量」是重标的证据
    expect(rows[0]).toMatchObject({ grams: 0, quantity: '适量' });
    // 其余项克数齐全 → 「部分待重标」的真实形态（不是整道菜没数）
    expect(rows.slice(1).every((row) => row.grams > 0 && row.quantity === null)).toBe(true);
  });

  it('008 不碰 004 的任何种子行（样张另开一条，不是改别人的菜）', () => {
    harness = createTestHarness();

    // 004 的家常豆腐：豆腐 180 / 肉末 30 / 豆瓣酱 12，克数全部是 004 当初写下的确切值
    const rows = harness.db
      .prepare(
        `SELECT ri.adult_grams AS grams, ri.source_quantity AS quantity, i.name AS ingredient
           FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
          WHERE ri.recipe_id = 'jiachangdoufu' ORDER BY ri.position`,
      )
      .all() as { grams: number; quantity: string | null; ingredient: string }[];
    expect(rows).toEqual([
      { grams: 180, quantity: null, ingredient: '豆腐' },
      { grams: 30, quantity: null, ingredient: '猪肉末' },
      { grams: 12, quantity: null, ingredient: '豆瓣酱' },
    ]);
    // 全库 0 克项只可能来自 008 的样张（004 的种子一项都没有）
    const zero = harness.db
      .prepare(
        `SELECT r.id FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id
          WHERE ri.adult_grams <= 0`,
      )
      .all() as { id: string }[];
    expect(zero.map((row) => row.id)).toEqual(['pending_relabel_ribs']);
  });
});
