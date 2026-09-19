import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import {
  buildReport,
  importDrafts,
  loadIngredientIndex,
  normalizeRecipe,
  relabelReport,
  seasonGrid,
  seasonIngredientCount,
  type DraftRecipe,
} from '../domain/library.js';
import { llmGeneratedDraft, xiachufangDraft } from './collectors.js';

/**
 * **可重复运行的冷启动报告**（AC：导入量、重标量、归一失败清单；数据量指标要用报告/测试呈现，
 * 不只在口头说数字）。
 *
 * 输入是仓库里的 `server/library-data/howtocook.jsonl`——HowToCook（Unlicense 公有领域）
 * 采集结果快照，由 `pnpm --filter @dinnerorder/server run import:library
 * --collect-htc <repo>/dishes --snapshot server/library-data/howtocook.jsonl` 生成。
 * 把快照入库而不是每次跑测试去 clone 上游：**测试不该依赖网络**，而且
 * 「ImportToCook 今天改了什么」不该让本票的断言飘走（快照更新是一次显式的动作）。
 *
 * 这个文件里的数字就是 AC 的验收数字：150–300 道、30–40 食材 × 12 月、重标覆盖率。
 */

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

const snapshotPath = fileURLToPath(new URL('../../library-data/howtocook.jsonl', import.meta.url));

function loadSnapshot(): DraftRecipe[] {
  return readFileSync(snapshotPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as DraftRecipe);
}

/** 跑一遍完整离线管线（归一 → 落库 → 报告），返回可断言的报告 */
function runImport() {
  const drafts = loadSnapshot();
  const index = loadIngredientIndex(harness.db);
  const recipes = [];
  for (const draft of drafts) {
    try {
      recipes.push(normalizeRecipe(index, draft).normalized);
    } catch {
      // 采集到的菜在归一阶段被拒（名字全对不上字典）——它进 rejected，不进 recipes
    }
  }
  const outcome = importDrafts(harness.db, { recipes });
  // 归一阶段被拒的菜也要出现在报告里（否则「导入量 + 被拒 ≠ 采集量」对不上）
  for (const draft of drafts) {
    if (!recipes.some((recipe) => recipe.id === draft.id)) {
      outcome.rejected.push({
        id: draft.id,
        name: draft.name,
        source: draft.source,
        sourceRef: draft.sourceRef,
        reason: '食材名全都没对上字典',
      });
    }
  }
  return { drafts, outcome, report: buildReport(harness.db, outcome, { generatedAt: '2025-09-19T00:00:00.000Z' }) };
}

describe('冷启动导入的数据量指标（AC：150–300 道草稿）', () => {
  it('真实 HowToCook 快照能导入 150–300 道草稿', () => {
    harness = createTestHarness();
    const { drafts, report } = runImport();

    // 采集量本身也要落在量级上：批的是「家常热度」，不是全站
    expect(drafts.length).toBeGreaterThanOrEqual(150);
    expect(drafts.length).toBeLessThanOrEqual(400);
    expect(report.imported.length).toBeGreaterThanOrEqual(150);
    expect(report.imported.length).toBeLessThanOrEqual(300);
  });

  it('落库的都是草稿（外部池的存储形态），来源如实标 howtocook', () => {
    harness = createTestHarness();
    runImport();
    const rows = harness.db.prepare('SELECT status, source, COUNT(*) AS n FROM recipes GROUP BY status, source').all() as {
      status: string;
      source: string;
      n: number;
    }[];
    const imported = rows.filter((row) => row.source === 'howtocook');
    expect(imported.length).toBeGreaterThanOrEqual(1);
    for (const row of imported) expect(row.status).toBe('draft');
    // 种子菜（oral / scraped / llm 的既有行）状态不变
    expect(rows.find((row) => row.source === 'oral' && row.status === 'active')?.n).toBeGreaterThan(0);
  });

  it('每道导入的草稿都有荤素位、食材与做法（不是空壳）', () => {
    harness = createTestHarness();
    const { report } = runImport();
    const sample = harness.db
      .prepare(
        `SELECT r.id, r.kind, r.effort, LENGTH(r.steps) AS steps_len,
                (SELECT COUNT(*) FROM recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredients
           FROM recipes r WHERE r.source = 'howtocook'`,
      )
      .all() as { id: string; kind: string; effort: string; steps_len: number; ingredients: number }[];
    // 004 的种子草稿也是 howtocook 来源，所以库里 howtocook 行**不少于**本次导入量
    // （断言写成相对本次导入——写死计数必坏：种子会随别的票变）
    expect(sample.length).toBeGreaterThanOrEqual(report.imported.length);
    for (const row of sample) {
      expect(['meat', 'veg', 'soup_meat', 'soup_veg']).toContain(row.kind);
      expect(row.ingredients).toBeGreaterThan(0);
      expect(row.steps_len).toBeGreaterThan(0);
    }
  });
});

describe('导入报告（AC 的交付物：导入量 / 重标量 / 归一失败清单）', () => {
  it('报告三个数字块都在，且能对上数据库的真实状态', () => {
    harness = createTestHarness();
    const { report } = runImport();

    // ① 导入量（按来源分开）
    expect(report.imported.length).toBeGreaterThanOrEqual(150);
    expect(report.imported.every((item) => item.source === 'howtocook')).toBe(true);
    expect(report.imported.every((item) => item.ingredients > 0)).toBe(true);

    // ② 重标量（覆盖率与待办：可重复读到的数据指标）
    const coverage = relabelReport(harness.db);
    expect(coverage.needed).toBe(coverage.done + coverage.pending.length);
    expect(coverage.coverage).toBeGreaterThan(0);
    expect(coverage.coverage).toBeLessThanOrEqual(1);
    expect(coverage.pending.length).toBeGreaterThan(0); // 没开 LLM 时确实还有待办（不是假装 100%）
    expect(report.relabel.needed).toBe(coverage.needed);
    // 待重标项要带**真原文**当证据（llm/import-schema.ts 的纪律 2：模型看到的是原文，
    // 不是我们替它猜的数）；采集侧的空 quantity 一项都收不上（collectors 那里就挡住）。
    // 断言是相对本次导入的：每一条待重标都应有非空原文，不写死条数。
    expect(report.relabel.pending.length).toBeGreaterThan(0);
    expect(report.relabel.pending.every((item) => item.quantity.trim() !== '')).toBe(true);

    // ③ 归一失败清单（非空：真实数据里总有字典还没覆盖的名字）
    expect(report.unmatched.length).toBeGreaterThan(0);
    expect(report.unmatched[0]).toMatchObject({ name: expect.any(String), occurrences: expect.any(Number) });
    expect(report.unmatched[0]!.dishes.length).toBeGreaterThan(0);
    // 失败清单按出现次数降序（报告首先是给人看的：先补影响面最大的别名）
    const counts = report.unmatched.map((item) => item.occurrences);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);

    // 接收/被拒/采集量三者自洽
    expect(report.imported.length + report.rejected.length).toBe(loadSnapshot().length);
  });

  it('来源字段是真实来源，不是一律写成同一个值（spec 的 AC：来源字段如实）', () => {
    harness = createTestHarness();
    const drafts = loadSnapshot();
    const sources = new Set(drafts.map((draft) => draft.source));
    expect(sources).toEqual(new Set(['howtocook']));
    // 同一批里混进来的下厨房草稿走**同一条管线**，但来源必须是 scraped
    const scraped = xiachufangDraft(
      { name: '蒜蓉蚝油生菜', url: 'https://www.xiachufang.com/recipe/107491076/' },
      readFileSync(fileURLToPath(new URL('./__fixtures__/xiachufang-detail.html', import.meta.url)), 'utf8'),
    )!;
    const generated = llmGeneratedDraft({ name: '番茄豆腐汤', ingredients: [{ name: '番茄', adultGrams: 200 }] }, '2025-09-19');
    const index = loadIngredientIndex(harness.db);
    importDrafts(harness.db, {
      recipes: [drafts[0]!, scraped, generated].map((draft) => normalizeRecipe(index, draft).normalized),
    });
    const rows = harness.db
      .prepare("SELECT source, COUNT(*) AS n FROM recipes WHERE status = 'draft' GROUP BY source ORDER BY source")
      .all() as { source: string; n: number }[];
    expect(rows.map((row) => row.source)).toEqual(['howtocook', 'llm', 'scraped']);
  });
});

describe('时令手工表的规模（AC：30–40 食材 × 12 月）', () => {
  it('40 种常买食材落在表里，12 个月每一列都有食材', () => {
    harness = createTestHarness();
    const count = seasonIngredientCount(harness.db);
    expect(count).toBeGreaterThanOrEqual(30);
    expect(count).toBeLessThanOrEqual(40);

    const grid = seasonGrid(harness.db);
    expect(grid).toHaveLength(12);
    for (const column of grid) expect(column.ingredients.length).toBeGreaterThan(0);
    // 12 列 × 每列至少一种 = 那张「× 12 月」的手工表确实铺满了月份轴
    expect(new Set(grid.flatMap((column) => column.ingredients.map((item) => item.id))).size).toBe(count);
  });
});
