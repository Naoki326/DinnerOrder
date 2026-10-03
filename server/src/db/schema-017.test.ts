import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 本迁移补的食材 id（**只此一处**：下面几条用例都按同一份清单查，不各写一遍）。
 *
 * 与 `017_fill_common_nutrition_gaps.sql` 的 INSERT 一一对应；改迁移时这里要一起改
 * ——清单短了或写错 id，第 2 条用例的 `toEqual` 会先红，不会静默漏测。
 */
const FILLED = [
  'pork',
  'chicken',
  'cooked_rice',
  'ginger_powder',
  'white_wine',
  'sweet_potato',
  'salted_duck_egg',
  'oyster',
  'rape',
  'pickled_mustard',
  'snow_peas',
];

/**
 * 迁移 017 的**迁移纪律**（补齐高频营养缺口，issue #39）。
 *
 * 与 schema-013/016 同一口径：只钉**没有写入口能触及**的那几条。
 * 「补录后的读数真的进合计」是行为断言，落在 `api/nutrition.test.ts`（本文件不重写一遍）。
 *
 * 本票是**纯数据票**：只往 `ingredient_nutrition` 加读数行。它必须守住的纪律比一般的票更硬，
 * 因为「数字由人来补」这件事唯一的成本就是**编数**：
 *
 *   1. **不碰 `ingredients` 与既有读数**：迁移动的只有 `ingredient_nutrition`，
 *      既有的 142 行一个数字都不许变（它们是 012 的读数，不是本票的）；
 *   2. **每一行都有出处（`source` 非空且带成分表食物名与原始 kJ）**：012 的逐行出处纪律原样延续；
 *   3. **`note` 的语义**：`0` 与「平台没给」才写说明——本批数字全部是完整读数，`note` 一律 `NULL`；
 *   4. **只补读数、不建条目**：`ingredients` 的条数不变（建条目会牵动别名/时令/忌口）。
 *
 * ## 为什么只有 11 条（与原 issue 的清单不符，是**如实缩减**）
 *
 * issue #39 的清单以「官方成分表平台（`nlc.chinanutri.cn/fq/`）可用」为前提。
 * 实施时实测该平台**已下线**（`504 Gateway Time-out`，来自它自己的 nginx；直连 IP、
 * 绕开本机代理、TLS 1.2/1.3 均同）——详见 `docs/agents/open-items.md` 的「归属 #39」。
 *
 * 可达的替代源只有 `halei125/food_nutrition_data`（该平台的直接爬取产物，**与 Wayback
 * 存下的平台页面逐字节一致**）可用，且它覆盖的一批里与 #39 清单重合的只有这 11 条。
 * 其余（蚝油 / 八角 / 香叶 / 桂皮 / 孜然 / 黑胡椒 / 辣椒粉 / 蒜粉 / 小苏打 …）**平台自己就没有**，
 * 宁可继续留在 `missingIngredients` 里，也不从与现有基数互相矛盾的版本里抄数字（那就是编数）。
 */
describe('017 迁移的营养补录纪律', () => {
  it('只写 ingredient_nutrition：字典与既有读数一个数字都不动', () => {
    harness = createTestHarness();

    // 字典条数不变（本票不建条目——那会牵动别名/时令/忌口，超出「补读数」的范围）。
    // 277 = 迁移种子总数（生产库的 278 多出来的一条是**运行时经界面录入**的，不在种子里）。
    const ingredients = (harness.db.prepare('SELECT COUNT(*) AS n FROM ingredients').get() as { n: number }).n;
    expect(ingredients).toBe(277);

    // 既有的两条种子读数原样（012 的猪大排与芝麻籽(白)）——本票没碰它们
    const ribs = harness.db
      .prepare('SELECT energy_kcal, protein_g, fat_g, carb_g FROM ingredient_nutrition WHERE ingredient_id = ?')
      .get('pork_ribs') as { energy_kcal: number; protein_g: number; fat_g: number; carb_g: number };
    expect(ribs).toEqual({ energy_kcal: 261.7, protein_g: 18.3, fat_g: 20.4, carb_g: 1.7 });
    const sesame = harness.db
      .prepare('SELECT energy_kcal FROM ingredient_nutrition WHERE ingredient_id = ?')
      .get('sesame_seed') as { energy_kcal: number };
    expect(sesame.energy_kcal).toBeCloseTo(531.8, 1);
  });

  it('每一行都带出处：source 写明成分表食物名、原始 kJ 与换算方式，且每项恰好一行', () => {
    harness = createTestHarness();

    const rows = harness.db
      .prepare(
        `SELECT ingredient_id, source FROM ingredient_nutrition WHERE ingredient_id IN (${FILLED.map(() => '?').join(', ')})`,
      )
      .all(...FILLED) as { ingredient_id: string; source: string }[];

    // 每项恰好一行（主键保证不会插出两条），且清单本身没写错 id
    expect(rows.map((row) => row.ingredient_id).sort()).toEqual([...FILLED].sort());
    for (const row of rows) {
      expect(row.source, row.ingredient_id).toContain('食物名「');
      expect(row.source, row.ingredient_id).toMatch(/：\d+(?:\.\d+)? kJ/);
      expect(row.source, row.ingredient_id).toContain('kcal = kJ ÷ 4.184');
      // 出处必须是**读数**（012 的格式），不能是 ADR-0013 的估算行——两者靠 source 区分
      expect(row.source, row.ingredient_id).not.toContain('LLM 估算');
    }
  });

  it('本批的四项都是完整读数：note 一律 NULL（没有「平台没给」要说明）', () => {
    harness = createTestHarness();

    const notes = harness.db
      .prepare(`SELECT ingredient_id, note FROM ingredient_nutrition WHERE ingredient_id IN (${FILLED.map(() => '?').join(', ')})`)
      .all(...FILLED) as { ingredient_id: string; note: string | null }[];

    expect(notes.filter((row) => row.note !== null)).toEqual([]);
  });
});
