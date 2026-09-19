import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import {
  NormalizationError,
  classifyCuisines,
  importDrafts,
  ingredientsWithoutSeason,
  loadIngredientIndex,
  normalizeIngredientName,
  normalizeRecipe,
  relabelDrafts,
  relabelReport,
  seasonGrid,
  seasonIngredientCount,
  tagDraftCuisines,
  type DraftRecipe,
} from './library.js';
import type { Recipe } from '../wire-types.js';

/**
 * 导入管线（总纲 §2.8、§5；ADR-0006）在**库这一侧**的行为。
 *
 * 采集器的解析在 `library/collectors.test.ts`（吃 fixture、不碰网），这里管的是：
 * 归一（对字典）、落库为草稿、份量重标的可见覆盖率、时令手工表的网格形状、
 * 以及「导进来的草稿真的能被推荐补位用上」这条端到端。
 */

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

function draft(overrides: Partial<DraftRecipe> & { id: string }): DraftRecipe {
  return {
    name: `菜${overrides.id}`,
    aliases: [],
    kind: 'meat',
    effort: 'quick',
    source: 'howtocook',
    sourceRef: `dishes/meat_dish/${overrides.id}.md`,
    tastes: ['咸鲜'],
    seasonMonths: [],
    cuisine: null,
    steps: '炒。',
    ingredients: [],
    ...overrides,
  };
}

function ingest(drafts: DraftRecipe[], options: { dryRun?: boolean } = {}) {
  const index = loadIngredientIndex(harness.db);
  const recipes = drafts.map((item) => normalizeRecipe(index, item).normalized);
  return importDrafts(harness.db, { recipes, dryRun: options.dryRun });
}

describe('食材字典归一', () => {
  it('规范名与别名都认（家人说「西红柿」，字典里叫「番茄」）', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    expect(normalizeIngredientName(index, '番茄')?.id).toBe('tomato');
    expect(normalizeIngredientName(index, '西红柿')?.id).toBe('tomato');
    // 别名这条也认
    expect(normalizeIngredientName(index, '大白菜')?.id).toBe('chinese_cabbage');
  });

  it('外部数据带修饰词的名字能归上（猪五花肉 → 五花肉、鲜香菇 → 香菇）', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    expect(normalizeIngredientName(index, '猪五花肉')?.id).toBe('pork_belly');
    expect(normalizeIngredientName(index, '鲜香菇')?.id).toBe('shiitake');
    // 包含匹配（名称里含字典名）：唯一候选才认（「青尖椒」含「尖椒」）
    expect(normalizeIngredientName(index, '青尖椒')?.id).toBe('hot_pepper');
    // 切法/品相修饰：剥一层后整字命中字典
    expect(normalizeIngredientName(index, '姜末')?.id).toBe('ginger');
    expect(normalizeIngredientName(index, '食用盐')?.id).toBe('salt');
  });

  it('归不上就是归不上（不猜）：名字里同时含多个字典名时判失败，进报告', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    // 「番茄酱」既是字典里的番茄酱，也包含「番茄」——精确命中优先，所以它归到番茄酱
    expect(normalizeIngredientName(index, '番茄酱')?.id).toBe('tomato_paste');
    // 完全没线索的名字不认（宁可进失败清单让人补别名，也不挂错食材）
    expect(normalizeIngredientName(index, '印度综合香料粉')).toBeUndefined();
    expect(normalizeIngredientName(index, '白芷')).toBeUndefined();
  });

  it('一道菜里一个食材名都没归上 → 整道菜被拒（不落一道空菜污染买菜聚合）', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    expect(() =>
      normalizeRecipe(
        index,
        draft({ id: 'x1', ingredients: [{ name: '白芷', adultGrams: 5, quantity: '5g', scaling: 'fixed' }] }),
      ),
    ).toThrow(NormalizationError);
  });

  it('归一保留原文名与「松散命中」标记（报告要说清它是从哪个叫法归过来的）', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    const { normalized, unmatched } = normalizeRecipe(
      index,
      draft({
        id: 'x2',
        ingredients: [
          { name: '猪五花肉', adultGrams: 200, quantity: '200g', scaling: 'linear' },
          { name: '白芷', adultGrams: 3, quantity: '3g', scaling: 'fixed' },
        ],
      }),
    );
    expect(normalized.ingredients).toHaveLength(1);
    expect(normalized.ingredients[0]!.rawName).toBe('猪五花肉');
    expect(normalized.ingredients[0]!.loose).toBe(true);
    expect(normalized.unmatchedNames).toEqual(['白芷']);
    expect(unmatched).toEqual(['白芷']);
  });
});

describe('落库为草稿（外部池的存储形态就是 status=draft，ADR-0006）', () => {
  it('来源字段如实：howtocook / scraped / llm 各归各（spec 的 AC）', () => {
    harness = createTestHarness();
    const outcome = ingest([
      draft({ id: 'htc_1', name: '测试导入菜A', source: 'howtocook' }),
      draft({ id: 'xcf_1', name: '测试导入菜B', source: 'scraped' }),
      draft({ id: 'llm_1', name: '测试导入菜C', source: 'llm' }),
    ].map((item) => ({
      ...item,
      ingredients: [{ name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' as const }],
    })));

    expect(outcome.imported.map((item) => item.source).sort()).toEqual(['howtocook', 'llm', 'scraped']);
    const rows = harness.db.prepare('SELECT id, source, status FROM recipes ORDER BY id').all() as {
      id: string;
      source: string;
      status: string;
    }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(rows.filter((row) => row.status === 'draft').length).toBeGreaterThanOrEqual(3);
    expect(byId.get('htc_1')?.source).toBe('howtocook');
    expect(byId.get('xcf_1')?.source).toBe('scraped');
    expect(byId.get('llm_1')?.source).toBe('llm');
    expect(byId.get('htc_1')?.status).toBe('draft');
  });

  it('菜系参考 tag 落库（导入时 LLM 初打，转正时校对归 #21）', () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_2', name: '测试导入菜D', cuisine: '川' }),
        ingredients: [{ name: '豆腐', adultGrams: 200, quantity: '200g', scaling: 'linear' }],
      },
    ]);
    const row = harness.db.prepare("SELECT cuisine FROM recipes WHERE id = 'htc_2'").get() as { cuisine: string };
    expect(row.cuisine).toBe('川');
  });

  it('没有明确克数的项以 0 克落库并出现在重标待办里（不编数、也不丢食材）', () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_3', name: '测试导入菜E' }),
        ingredients: [
          { name: '五花肉', adultGrams: 200, quantity: '约 3~4 斤', scaling: 'linear' },
          { name: '盐', adultGrams: null, quantity: '适量', scaling: 'fixed' },
        ],
      },
    ]);
    // 覆盖率是**跨全库草稿**的指标（报告口径），所以断言一律相对本次导入的那道菜
    const pending = relabelReport(harness.db).pending.filter((item) => item.recipeId === 'htc_3');
    expect(pending.map((item) => item.ingredient)).toEqual(['盐']);
    expect(pending[0]!.recipeName).toBe('测试导入菜E');
    // 待重标项的**份量原文**是重标的证据（llm/import-schema.ts 的纪律 2）：报告里不能是空串
    expect(pending[0]!.quantity).toBe('适量');

    // 原文也落在 recipe_ingredients.source_quantity 上（有克数的项同样留着，报告要能回溯）
    const sourceQuantities = harness.db
      .prepare(
        `SELECT i.name, ri.source_quantity FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
          WHERE ri.recipe_id = 'htc_3' ORDER BY ri.position`,
      )
      .all() as { name: string; source_quantity: string | null }[];
    expect(sourceQuantities).toEqual([
      { name: '五花肉', source_quantity: '约 3~4 斤' },
      { name: '盐', source_quantity: '适量' },
    ]);

    // 覆盖率的分母是草稿里的全部食材项（含 002/004 的种子草稿），分子是已重标的那些：
    // 这样分母不会随重标进度缩小（否则重标一半时覆盖率就已经是 100%）
    const report = relabelReport(harness.db);
    expect(report.needed).toBe(report.done + report.pending.length);
    expect(report.coverage).toBeLessThan(1);
    expect(report.coverage).toBeGreaterThan(0);
  });

  it('dry-run 只算不写，但报告里的数字是「真的写下去会怎样」（不是导入前的旧状态）', () => {
    harness = createTestHarness();
    const before = relabelReport(harness.db);
    const outcome = ingest(
      [
        {
          ...draft({ id: 'htc_4', name: '测试导入菜F' }),
          ingredients: [
            { name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' },
            { name: '盐', adultGrams: null, quantity: '适量', scaling: 'fixed' },
          ],
        },
      ],
      { dryRun: true },
    );
    // 报告说「会导入 1 道、库里的待重标会变成 …」——但库里其实什么都没变
    expect(outcome.imported).toHaveLength(1);
    expect(outcome.relabel.needed).toBe(before.needed + 2);
    expect(outcome.relabel.pending.filter((item) => item.recipeId === 'htc_4')).toHaveLength(1);
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE id = ?').get('htc_4')).toEqual({ n: 0 });
    expect(relabelReport(harness.db).needed).toBe(before.needed);
  });

  it('重名菜不覆盖：家庭菜谱与已有草稿都不动（导入只写新的草稿）', () => {
    harness = createTestHarness();
    const outcome = ingest([
      {
        ...draft({ id: 'htc_dup', name: '麻婆豆腐' }), // 与 002 种子的家庭菜谱同名
        ingredients: [{ name: '豆腐', adultGrams: 200, quantity: '200g', scaling: 'linear' }],
      },
    ]);
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.rejected[0]!.reason).toContain('已存在');
    const original = harness.db.prepare("SELECT status FROM recipes WHERE name = '麻婆豆腐'").get() as { status: string };
    expect(original.status).toBe('active');
  });

  it('幂等：同一份快照导入两次，第二次全部跳过（重跑不会把池子导成两倍）', () => {
    harness = createTestHarness();
    const item: DraftRecipe = {
      ...draft({ id: 'htc_5', name: '测试导入菜G' }),
      ingredients: [{ name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' }],
    };
    expect(ingest([item]).imported).toHaveLength(1);
    const second = ingest([item]);
    expect(second.imported).toHaveLength(0);
    expect(second.rejected).toHaveLength(1);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM recipes WHERE name = '测试导入菜G'").get()).toEqual({ n: 1 });
  });

  it('onConflict=skip 是缺省（重跑幂等）；=replace 刷新已有草稿（补了别名之后重跑用）', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    const item: DraftRecipe = {
      ...draft({ id: 'htc_rep', name: '测试导入菜R' }),
      ingredients: [{ name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' }],
    };
    importDrafts(harness.db, { recipes: [normalizeRecipe(index, item).normalized] });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_id = 'htc_rep'").get()).toEqual({
      n: 1,
    });

    // 补了别名（原来的「白芷」现在能归上）之后重跑：skip 不动旧行，replace 把草稿刷新成两条
    const improved: DraftRecipe = {
      ...item,
      ingredients: [
        { name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' },
        { name: '蒜', adultGrams: 8, quantity: '8g', scaling: 'fixed' },
      ],
    };
    const skipOutcome = importDrafts(harness.db, { recipes: [normalizeRecipe(index, improved).normalized] });
    expect(skipOutcome.imported).toHaveLength(0);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_id = 'htc_rep'").get()).toEqual({
      n: 1,
    });

    const replaceOutcome = importDrafts(harness.db, {
      recipes: [normalizeRecipe(index, improved).normalized],
      onConflict: 'replace',
    });
    expect(replaceOutcome.imported).toHaveLength(1);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_id = 'htc_rep'").get()).toEqual({
      n: 2,
    });
    // 草稿被刷新，但**没有**变成两条菜（同一 id 只有一行）
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM recipes WHERE id = 'htc_rep'").get()).toEqual({ n: 1 });
  });

  it('replace 也不许覆盖家庭菜谱（非草稿状态一律拒）', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    const outcome = importDrafts(harness.db, {
      recipes: [
        normalizeRecipe(index, {
          ...draft({ id: 'htc_active', name: '麻婆豆腐' }),
          ingredients: [{ name: '豆腐', adultGrams: 200, quantity: '200g', scaling: 'linear' }],
        }).normalized,
      ],
      onConflict: 'replace',
    });
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.rejected[0]!.reason).toContain('不能覆盖');
    const row = harness.db.prepare("SELECT status FROM recipes WHERE name = '麻婆豆腐'").get() as { status: string };
    expect(row.status).toBe('active');
  });

  it('归一失败清单是这批数据的实情：重跑（全被 skip）时清单照样在', () => {
    harness = createTestHarness();
    harness.db.prepare("INSERT INTO ingredients (id, name) VALUES ('unused_marker', '兰香子')").run();
    const index = loadIngredientIndex(harness.db);
    const item: DraftRecipe = {
      ...draft({ id: 'htc_un', name: '测试导入菜U' }),
      ingredients: [
        { name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' },
        { name: '白芷', adultGrams: 3, quantity: '3g', scaling: 'fixed' },
      ],
    };
    const recipe = normalizeRecipe(index, item).normalized;
    const first = importDrafts(harness.db, { recipes: [recipe] });
    expect(first.unmatched.map((entry) => entry.name)).toEqual(['白芷']);
    // 第二次全被 skip，但清单不该因此变成空的——否则报告会谎报「这批数据干净」
    const second = importDrafts(harness.db, { recipes: [recipe] });
    expect(second.imported).toHaveLength(0);
    expect(second.unmatched.map((entry) => entry.name)).toEqual(['白芷']);
  });

  it('归一失败清单进报告（AC：归一失败清单是交付物之一）', () => {
    harness = createTestHarness();
    const outcome = ingest([
      {
        ...draft({ id: 'htc_6', name: '测试导入菜H' }),
        ingredients: [
          { name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' },
          { name: '白芷', adultGrams: 3, quantity: '3g', scaling: 'fixed' },
          { name: '印度综合香料粉', adultGrams: 3, quantity: '3g', scaling: 'fixed' },
        ],
      },
    ]);
    expect(outcome.unmatched.map((item) => item.name).sort()).toEqual(['印度综合香料粉', '白芷'].sort());
    expect(outcome.unmatched[0]!.dishes).toContain('测试导入菜H');
  });
});

describe('时令手工表（总纲 §5：30–40 种常买食材 × 12 月）', () => {
  it('录入种数落在 30–40（本票补到 40）', () => {
    harness = createTestHarness();
    const count = seasonIngredientCount(harness.db);
    expect(count).toBeGreaterThanOrEqual(30);
    expect(count).toBeLessThanOrEqual(40);
  });

  it('网格是 12 列，每一列都有食材落上去（「× 12 月」的形状）', () => {
    harness = createTestHarness();
    const grid = seasonGrid(harness.db);
    expect(grid).toHaveLength(12);
    expect(grid.map((column) => column.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const column of grid) expect(column.ingredients.length).toBeGreaterThan(0);
  });

  it('口径不变：未录月份的食材仍是「四季有售」，不是「非当季」（#17 审查确认的语义）', () => {
    harness = createTestHarness();
    const grid = seasonGrid(harness.db);
    const monthsOf = (id: string): number[] =>
      grid.filter((column) => column.ingredients.some((item) => item.id === id)).map((column) => column.month);
    // 补录后的土豆是秋末冬储的菜，不是全年
    expect(monthsOf('potato')).toEqual([1, 10, 11, 12]);
    // 豆腐没录时令（四季有售），不在网格里
    expect(monthsOf('tofu')).toEqual([]);
    // 「还没录时令的食材」是可数的欠账清单
    expect(ingredientsWithoutSeason(harness.db).length).toBeGreaterThan(0);
  });
});

describe('份量重标（LLM 离线路径；本机端点走 json_object + 校验）', () => {
  it('重标把 0 克的项写回克数，覆盖率随之上升', async () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_7', name: '测试导入菜I' }),
        ingredients: [
          { name: '五花肉', adultGrams: null, quantity: '约 3~4 斤', scaling: 'linear' },
          { name: '盐', adultGrams: null, quantity: '适量', scaling: 'fixed' },
        ],
      },
    ]);
    // 库里还有 002/004 的种子草稿，所以覆盖率不是从 0 开始——只看**本次导入这道菜**的两项
    const before = relabelReport(harness.db);
    expect(before.pending.filter((item) => item.recipeId === 'htc_7')).toHaveLength(2);

    harness.llm.setCompletion(
      JSON.stringify({
        dishes: [{ recipeId: 'htc_7', ingredients: [{ name: '五花肉', grams: 130 }, { name: '盐', grams: 2 }] }],
      }),
    );
    const outcome = await relabelDrafts(harness.db, harness.llm);
    expect(outcome.calls).toBe(1);

    // 送给 LLM 的请求里带着**真原文**（不是空串）：模型据此把「约 3~4 斤」判成克数，
    // 否则就是在盲标（llm/import-schema.ts 的纪律 2 明写原文是证据）
    const sent = relabelRequestsOf(harness.llm.completionCalls[0]!.request.prompt).find((entry) => entry.recipeId === 'htc_7');
    expect(sent?.ingredients).toEqual([
      { name: '五花肉', quantity: '约 3~4 斤' },
      { name: '盐', quantity: '适量' },
    ]);

    expect(relabelReport(harness.db).done).toBeGreaterThan(before.done);
    expect(relabelReport(harness.db).pending.filter((item) => item.recipeId === 'htc_7')).toHaveLength(0);

    const grams = harness.db
      .prepare(
        `SELECT i.name, ri.adult_grams FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
          WHERE ri.recipe_id = 'htc_7' ORDER BY ri.position`,
      )
      .all() as { name: string; adult_grams: number }[];
    expect(grams).toEqual([
      { name: '五花肉', adult_grams: 130 },
      { name: '盐', adult_grams: 2 },
    ]);
  });

  it('调用的就是 json_object 档（本机端点不支持 strict schema，preflight 记录的能力事实）', async () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_8', name: '测试导入菜J' }),
        ingredients: [{ name: '番茄', adultGrams: null, quantity: '适量', scaling: 'linear' }],
      },
    ]);
    harness.llm.setCompletion(JSON.stringify({ dishes: [{ recipeId: 'htc_8', ingredients: [{ name: '番茄', grams: 150 }] }] }));
    await relabelDrafts(harness.db, harness.llm);
    expect(harness.llm.completionCalls[0]!.request.responseFormat).toBe('json_object');
    // 离线批处理要可复现：温度不是推荐的 0.7
    expect(harness.llm.completionCalls[0]!.request.temperature).toBeLessThan(0.7);
  });

  it('模型失败/形状不合时**不写库**、不抛错，留成可见欠账（重标待办里还在）', async () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_9', name: '测试导入菜K' }),
        ingredients: [{ name: '番茄', adultGrams: null, quantity: '适量', scaling: 'linear' }],
      },
    ]);
    harness.llm.setCompletionError(new Error('端点超时'));
    const outcome = await relabelDrafts(harness.db, harness.llm, { maxAttempts: 2 });
    expect(outcome.notes.join('')).toContain('端点超时');
    expect(relabelReport(harness.db).pending).toHaveLength(1);

    // 形状不合（负数克数）：Zod 挡住，同样不写库
    harness.llm.setCompletionError(undefined as unknown as Error);
    harness.llm.clearCalls();
    harness.llm.setCompletion(JSON.stringify({ dishes: [{ recipeId: 'htc_9', ingredients: [{ name: '番茄', grams: -5 }] }] }));
    const bad = await relabelDrafts(harness.db, harness.llm, { maxAttempts: 1 });
    expect(bad.notes.join('')).toContain('形状不合');
    expect(relabelReport(harness.db).pending.filter((item) => item.recipeId === 'htc_9')).toHaveLength(1);
  });

  it('模型改了名的项不认（写入按「菜 + 食材名」精确匹配）', async () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_10', name: '测试导入菜L' }),
        ingredients: [
          { name: '番茄', adultGrams: null, quantity: '适量', scaling: 'linear' },
          { name: '鸡蛋', adultGrams: null, quantity: '适量', scaling: 'linear' },
        ],
      },
    ]);
    harness.llm.setCompletion(
      JSON.stringify({ dishes: [{ recipeId: 'htc_10', ingredients: [{ name: '西红柿', grams: 200 }] }] }),
    );
    await relabelDrafts(harness.db, harness.llm, { maxAttempts: 1 });
    // 「西红柿」这个名字没在本次请求里出现 → 不认；两项都还等着重标
    expect(relabelReport(harness.db).pending.filter((item) => item.recipeId === 'htc_10')).toHaveLength(2);
  });

  it('只碰草稿：家庭菜谱的克数不因重标被动（那是掌勺者确认过的值）', async () => {
    harness = createTestHarness();
    // 0 克的家庭菜谱是异常数据，但即便存在，重标也不该去改它
    harness.db
      .prepare("UPDATE recipe_ingredients SET adult_grams = 0 WHERE recipe_id = 'hongshaopaigu' AND ingredient_id = 'pork_ribs'")
      .run();
    harness.llm.setCompletion(JSON.stringify({ dishes: [{ recipeId: 'hongshaopaigu', ingredients: [{ name: '猪排骨', grams: 999 }] }] }));
    await relabelDrafts(harness.db, harness.llm);
    const row = harness.db
      .prepare("SELECT adult_grams FROM recipe_ingredients WHERE recipe_id = 'hongshaopaigu' AND ingredient_id = 'pork_ribs'")
      .get() as { adult_grams: number };
    expect(row.adult_grams).toBe(0);
  });
});

describe('菜系参考 tag 的初打（§2.8：导入时 LLM 初打）', () => {
  it('只给草稿里还没 tag 的菜问一次，写回白名单内的值', async () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_11', name: '测试导入菜M', cuisine: null }),
        ingredients: [{ name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' }],
      },
    ]);
    harness.llm.setCompletion(JSON.stringify({ dishes: [{ recipeId: 'htc_11', cuisine: '川' }] }));
    const outcome = await tagDraftCuisines(harness.db, harness.llm, { maxAttempts: 1 });
    // 「测试导入菜M」是本次唯一还没 tag 的新草稿（002/004 的种子已有菜系或已被 LLM 问过）
    expect(outcome.requests).toBeGreaterThanOrEqual(1);
    expect(
      (harness.db.prepare("SELECT cuisine FROM recipes WHERE id = 'htc_11'").get() as { cuisine: string }).cuisine,
    ).toBe('川');
  });

  it('白名单外的值不落库（保持 null，等转正时掌勺者校对）', async () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_12', name: '测试导入菜N' }),
        ingredients: [{ name: '番茄', adultGrams: 100, quantity: '100g', scaling: 'linear' }],
      },
    ]);
    const outcome = await classifyCuisines(harness.llm, [{ recipeId: 'htc_12', recipeName: '测试导入菜N', tasteHint: [] }], {
      maxAttempts: 1,
    });
    harness.llm.setCompletion(JSON.stringify({ dishes: [{ recipeId: 'htc_12', cuisine: '法餐' }] }));
    const rejected = await classifyCuisines(harness.llm, [{ recipeId: 'htc_12', recipeName: '测试导入菜N', tasteHint: [] }], {
      maxAttempts: 1,
    });
    expect(rejected.cuisines.size).toBe(0);
    expect(outcome.cuisines.size).toBe(0);
    await tagDraftCuisines(harness.db, harness.llm, { maxAttempts: 1 });
    expect(
      (harness.db.prepare("SELECT cuisine FROM recipes WHERE id = 'htc_12'").get() as { cuisine: string | null }).cuisine,
    ).toBeNull();
  });
});

describe('食材字典与 WS/T 554 互换表对齐（AC「WS/T 554 互换表 + 导入归一」）', () => {
  it('互换表里能对上字典的条目都挂上了 ingredient_id（买菜聚合靠它，#23）', () => {
    harness = createTestHarness();
    const rows = harness.db
      .prepare('SELECT id, name, ingredient_id FROM exchange_items ORDER BY id')
      .all() as { id: string; name: string; ingredient_id: string | null }[];

    // 本金（米饭/粥/馒头/面类/市品重的水果等）本来就不该挂字典——它们是把生重换算成
    // 「买回来的熟食/市品」的中转口径。**挂了字典的必须真在字典里**（外键保证），
    // 而「名字能对上却忘了挂」的要能被这条测试抓出来。
    const index = loadIngredientIndex(harness.db);
    const shouldLink = rows.filter((row) => index.byName.has(row.name));
    expect(shouldLink.length).toBeGreaterThan(0);
    for (const row of shouldLink) {
      expect(row.ingredient_id).toBe(index.byName.get(row.name));
    }
  });

  it('互换表挂上字典后，字典条目本身没被污染（互换是另一张表，不是新食材）', () => {
    harness = createTestHarness();
    const index = loadIngredientIndex(harness.db);
    // 本轮新挂的那几条：干黄豆 / 豆浆 / 北豆腐 / 豆腐干 / 黄瓜 / 大白菜 / 整鸡
    expect(index.byName.get('干黄豆')).toBe('soybean');
    expect(index.byName.get('豆浆')).toBe('soy_milk');
    expect(index.byName.get('北豆腐')).toBe('tofu');
    // 字典里没有「米饭」这个食材（它是主食组的熟重中转口径，不是买菜项）
    expect(index.byName.get('米饭')).toBeUndefined();
  });
});

describe('导入的草稿真的能补位进推荐（ADR-0006：外部池是素材层，家里没做过就标「没做过」）', () => {
  it('草稿经 HTTP 出现在草稿列表里，且带来源、菜系与克数', async () => {
    harness = createTestHarness();
    ingest([
      {
        ...draft({ id: 'htc_13', name: '测试补位荤菜', cuisine: '湘' }),
        ingredients: [
          { name: '鸡腿', adultGrams: 140, quantity: '140g', scaling: 'linear' },
          { name: '姜', adultGrams: null, quantity: '一块', scaling: 'fixed' },
        ],
      },
    ]);
    const { status, body } = await harness.json<{ recipes: Recipe[] }>('/api/recipes?status=draft');
    expect(status).toBe(200);
    const imported = body.recipes.find((recipe) => recipe.id === 'htc_13');
    expect(imported).toMatchObject({ status: 'draft', source: 'howtocook', cuisine: '湘', kind: 'meat' });
    // 没重标的项是 0 克而不是丢失（食材还在清单里，进重标待办）
    expect(imported!.ingredients.find((item) => item.ingredientId === 'ginger')?.adultGrams).toBe(0);
  });

  it('家庭荤位候选不足时草稿补位：进的是**带「外部（没做过）」标记**的池子', async () => {
    harness = createTestHarness();
    // 先把家庭荤菜全退役，逼出「某位 <3 → 外部池补足」这条路径（总纲 §4①）
    harness.db.prepare("UPDATE recipes SET status = 'retired' WHERE status = 'active' AND kind = 'meat'").run();
    ingest([
      {
        ...draft({ id: 'htc_14', name: '测试补位荤菜B' }),
        ingredients: [{ name: '鸡腿', adultGrams: 140, quantity: '140g', scaling: 'linear' }],
      },
    ]);

    harness.llm.setCompletion((request) => {
      // 结构对不上（少一道）会掉进简化推荐，所以这里让 fake 照结构把每一位填满，与 E2E 的 fake 同一路数。
      // 荤位**优先挑导入的那道草稿**，其余位按池子顺序取——要验的正是「草稿能补位」。
      const structure = JSON.parse(/【本餐结构】\n(.*)/.exec(request.prompt)![1]!) as {
        need: { meat: number; veg: number; soup: number };
      };
      const pool = promptPool(request.prompt);
      const taken = { meat: 0, veg: 0, soup: 0 };
      const dishes: { recipeId: string; reason: string }[] = [];
      const imported = pool.find((entry) => entry.id === 'htc_14');
      if (imported) {
        dishes.push({ recipeId: imported.id, reason: '荤位补位。' });
        taken.meat += 1;
      }
      for (const entry of pool) {
        const position = entry.kind === 'meat' ? 'meat' : entry.kind === 'veg' ? 'veg' : 'soup';
        if (taken[position] >= structure.need[position]) continue;
        taken[position] += 1;
        dishes.push({ recipeId: entry.id, reason: '凑位。' });
      }
      return JSON.stringify({ dishes });
    });

    const { status, body } = await harness.json<{ recommendation: { dishes: { recipeId: string; origin: string }[] } }>(
      '/api/slots/2025-06-02:dinner/recommendation',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diners: ['mom', 'dad'] }) },
    );
    expect(status).toBe(200);
    // 草稿进了池子，来源标「外部（没做过）」——界面据此显著标记（spec S6）
    const entry = promptPool(harness.llm.completionCalls[0]!.request.prompt).find((item) => item.id === 'htc_14');
    expect(entry?.source).toBe('外部（没做过）');
    // 被选中的补位菜在响应里带 origin='external'
    expect(body.recommendation.dishes.find((dish) => dish.recipeId === 'htc_14')?.origin).toBe('external');
  });
});

/** 从 prompt 的【候选池】段读回池子（与 fake LLM 同一口径：只读 prompt 本身） */
function promptPool(prompt: string): { id: string; kind: string; source?: string }[] {
  const block = /【候选池】\n(.*)/.exec(prompt)?.[1];
  return block ? (JSON.parse(block) as { id: string; kind: string; source?: string }[]) : [];
}

/** 从重标 prompt 的第二行（那个 JSON 数组）读回送出去的请求——断言「LLM 被问了什么」 */
function relabelRequestsOf(prompt: string): { recipeId: string; name: string; ingredients: { name: string; quantity: string }[] }[] {
  return JSON.parse(prompt.split('\n').slice(1).join('\n')) as {
    recipeId: string;
    name: string;
    ingredients: { name: string; quantity: string }[];
  }[];
}
