import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import type {
  MenuNutrition,
  MenuNutritionResponse,
  MenuPortion,
  RecipeDetailResponse,
  SlotResponse,
} from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 每餐营养 + 每道菜食谱（本票）。
 *
 * 三条不变量在这里守：
 * 1. **营养必须复用份量**：留量上浮（#22）真的进到营养里——同一份菜单，有「吃剩的」引用
 *    与没有引用，能量读数必须不同（只靠常量断言证明不了「乘法真的接上了」）。
 * 2. **缺失食材不当 0**：缺数据的食材那一项是 null 且不进合计，整餐把「哪些食材没有数据」
 *    报出来（`missingIngredients`）。拿蚝油生菜（蚝油平台查不到）当真实样本。
 * 3. **空 steps 要能优雅表达**：食谱接口照原样返回空串，不自作主张编一句做法。
 *
 * 与其余 API 测试同口径：只断言外部可见行为（HTTP 形状与数字），不查表结构。
 */

const ALL = ['mom', 'dad', 'dabao', 'xiaobao'];

async function book(id: string, payload: unknown): Promise<void> {
  const { status } = await harness.json(`/api/slots/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(status).toBe(200);
}

async function nutrition(id: string): Promise<MenuNutrition | null> {
  const { status, body } = await harness.json<MenuNutritionResponse>(`/api/slots/${id}/nutrition`);
  expect(status).toBe(200);
  return body.nutrition;
}

async function portion(id: string): Promise<MenuPortion | null> {
  const { status, body } = await harness.json<SlotResponse>(`/api/slots/${id}`);
  expect(status).toBe(200);
  return body.slot.portion;
}

function dishOf(nutrition: MenuNutrition, recipeId: string) {
  const dish = nutrition.dishes.find((item) => item.recipeId === recipeId);
  if (!dish) throw new Error(`没有这道菜：${recipeId}`);
  return dish;
}

describe('一餐的营养合计', () => {
  it('未定的餐槽没有营养（没有菜单就没有营养），定了就有', async () => {
    harness = createTestHarness();
    expect(await nutrition('2025-06-01:dinner')).toBeNull();

    await book('2025-06-01:dinner', { diners: ['mom'], dishes: [{ recipeId: 'hongshaopaigu' }] });
    const result = (await nutrition('2025-06-01:dinner'))!;
    expect(result.asOf).toBe('2025-06-01');
    expect(result.factorSum).toBeCloseTo(1, 6);
    expect(result.energyKcal).toBeGreaterThan(0);
  });

  it('营养与份量同源：逐个食材的能量 = 本餐克数 ÷ 100 × 每 100 g 能量，合计等于逐项之和', async () => {
    harness = createTestHarness();
    // 两个成人：红烧排骨 = 猪排骨 300 g（150 × 2）
    await book('2025-06-01:dinner', { diners: ['mom', 'dad'], dishes: [{ recipeId: 'hongshaopaigu' }] });

    const result = (await nutrition('2025-06-01:dinner'))!;
    const portionResult = (await portion('2025-06-01:dinner'))!;
    const dish = dishOf(result, 'hongshaopaigu');
    const ribs = dish.ingredients[0]!;

    // 份量读数与营养读数用的是同一份克数（不是各自算了一遍）
    expect(ribs.grams).toBe(portionResult.dishes[0]!.ingredients[0]!.grams);
    expect(ribs.grams).toBe(300);
    // 猪大排（每 100 g）：1095 kJ → 261.7 kcal，蛋白 18.3、脂肪 20.4、碳水 1.7
    expect(ribs.per100g?.energyKcal).toBeCloseTo(261.7, 1);
    expect(ribs.energyKcal).toBeCloseTo((300 / 100) * 261.7, 1);
    expect(ribs.proteinG).toBeCloseTo((300 / 100) * 18.3, 1);
    expect(dish.energyKcal).toBeCloseTo(ribs.energyKcal!, 1);
    expect(result.energyKcal).toBeCloseTo(dish.energyKcal, 1);
    // 平台数据齐全的一道菜：没有缺口
    expect(dish.partial).toBe(false);
    expect(result.missingIngredients).toEqual([]);
  });

  it('留量上浮真的进到营养里：同一份菜单，有「吃剩的」引用时能量更高（不是只乘在份量上）', async () => {
    harness = createTestHarness();
    // 午餐：四个人的红烧排骨，标了留量
    await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }],
    });
    // 没有引用时（午餐自己）：上浮不生效
    const plain = (await nutrition('2025-06-02:lunch'))!;
    expect(plain.uplift).toBe(1);

    // 晚餐预定成「吃中午剩的」→ 引用生效 → 午餐同一条菜单的营养要变高（×1.5）
    await book('2025-06-02:dinner', { diners: ALL, dishes: [], leftoverOf: '2025-06-02:lunch' });
    const uplifted = (await nutrition('2025-06-02:lunch'))!;
    expect(uplifted.uplift).toBe(1.5);
    expect(uplifted.energyKcal).toBeGreaterThan(plain.energyKcal);
    // 逐食材克数真的乘了 1.5（150 × 3.164 = 475 → 150 × 4.746 = 711.9 → 712）：
    // 两次取整的时机不同，允许 1 g 的舍入差，但方向与量级必须是 1.5×
    const plainRibs = dishOf(plain, 'hongshaopaigu').ingredients[0]!;
    const upRibs = dishOf(uplifted, 'hongshaopaigu').ingredients[0]!;
    expect(Math.abs(upRibs.grams - plainRibs.grams * 1.5)).toBeLessThanOrEqual(1);
    expect(upRibs.energyKcal! / plainRibs.energyKcal!).toBeCloseTo(1.5, 1);
  });

  it('人均口径可复算：整餐总量 ÷ Σ折算系数 = 每人份（界面靠这句话说明口径）', async () => {
    harness = createTestHarness();
    await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });

    const result = (await nutrition('2025-06-01:dinner'))!;
    // 四大口人（mom 1 + dad 1 + dabao 0.756 + xiaobao 0.408 = 3.164）
    expect(result.factorSum).toBeCloseTo(3.164, 6);
    expect(result.diners).toHaveLength(4);
    // 换成每人份就是再除一次 Σ系数——数字口径是整餐总量
    const perPerson = result.energyKcal / result.factorSum;
    expect(perPerson).toBeGreaterThan(0);
    expect(perPerson).toBeLessThan(result.energyKcal);
  });
});

describe('缺数据的食材', () => {
  it('蚝油没有营养数据：那一项是 null、不进合计，整餐把缺口报出来（不当 0 算）', async () => {
    harness = createTestHarness();
    // 蚝油生菜：莴苣（有数据）+ 蚝油（平台查不到）
    await book('2025-06-01:dinner', { diners: ['mom'], dishes: [{ recipeId: 'haoyoushengcai' }] });

    const result = (await nutrition('2025-06-01:dinner'))!;
    const dish = dishOf(result, 'haoyoushengcai');
    const oyster = dish.ingredients.find((item) => item.ingredientId === 'oyster_sauce')!;
    // 缺数据：per100g 与四项都是 null（**不是 0**——0 会让「没算」与「算出来是零」分不清）
    expect(oyster.per100g).toBeNull();
    expect(oyster.energyKcal).toBeNull();
    expect(oyster.proteinG).toBeNull();
    // 合计只含有数据的那些项：蚝油那 10 g 没进合计
    const lettuce = dish.ingredients.find((item) => item.ingredientId === 'lettuce')!;
    expect(dish.energyKcal).toBeCloseTo(lettuce.energyKcal!, 1);
    expect(dish.partial).toBe(true);
    // 缺口在整餐这一层说得出来（界面上「为什么看起来偏低」全靠它）
    expect(result.missingIngredients).toEqual([{ ingredientId: 'oyster_sauce', name: '蚝油' }]);
    expect(result.nutritionSource).toContain('参考值');
  });

  it('整餐跨多道菜时缺口去重、按出现次序给（同一味食材出现在两道菜里只报一次）', async () => {
    harness = createTestHarness();
    await book('2025-06-01:dinner', {
      diners: ['mom'],
      dishes: [{ recipeId: 'haoyoushengcai' }, { recipeId: 'hongshaopaigu' }],
    });

    const result = (await nutrition('2025-06-01:dinner'))!;
    expect(result.missingIngredients).toEqual([{ ingredientId: 'oyster_sauce', name: '蚝油' }]);
    // 有缺口时合计仍然给出（是「部分食材的合计」，不是拒绝计算）——这是本票选的口径
    expect(result.energyKcal).toBeGreaterThan(0);
    expect(result.dishes.find((dish) => dish.recipeId === 'hongshaopaigu')?.partial).toBe(false);
    expect(result.dishes.find((dish) => dish.recipeId === 'haoyoushengcai')?.partial).toBe(true);
  });

  it('水不算「缺数据」：定义性零点不污染缺口清单（否则每道炖菜都报警）', async () => {
    harness = createTestHarness();
    // 自建一道用了水的菜：借「红烧排骨」的 id 不存在——用数据库直插一条测试用的菜谱
    harness.db
      .prepare(
        `INSERT INTO recipes (id, name, kind, effort, status, source, steps)
         VALUES ('probe_water_soup', '探针汤', 'soup_veg', 'quick', 'active', 'oral', '')`,
      )
      .run();
    harness.db
      .prepare(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, position, adult_grams, scaling)
         VALUES ('probe_water_soup', 'water', 0, 300, 'linear')`,
      )
      .run();

    await book('2025-06-01:dinner', { diners: ['mom'], dishes: [{ recipeId: 'probe_water_soup' }] });
    const result = (await nutrition('2025-06-01:dinner'))!;
    expect(result.missingIngredients).toEqual([]);
    // 水那 300 g 的营养全 0，但**不是** null：界面上不会说「这道缺数据」
    const water = dishOf(result, 'probe_water_soup').ingredients[0]!;
    expect(water.per100g).not.toBeNull();
    expect(water.energyKcal).toBe(0);
    expect(result.energyKcal).toBe(0);
  });

  it('整餐没有菜单时接口拒绝（与份量同一套餐槽校验）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error?: string }>('/api/slots/瞎写的/nutrition');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_slot_id');
  });
});

describe('每道菜的食谱', () => {
  it('返回做法步骤原文 + 食材清单（成人份基准，不随人数放大）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<RecipeDetailResponse>('/api/recipes/hongshaopaigu/recipe');
    expect(status).toBe(200);
    expect(body.recipe.steps.length).toBeGreaterThan(0);
    expect(body.recipe.steps).toContain('排骨');
    // 清单是菜谱自己的成人份基准（150 g），不是某一餐的克数
    expect(body.recipe.ingredients[0]).toMatchObject({ ingredientId: 'pork_ribs', adultGrams: 150, scaling: 'linear' });
  });

  it('steps 是空串时照原样返回空串（不替它编一句做法，由界面表达「还没写」）', async () => {
    harness = createTestHarness();
    harness.db
      .prepare(
        `INSERT INTO recipes (id, name, kind, effort, status, source, steps)
         VALUES ('probe_no_steps', '还没写做法的菜', 'veg', 'quick', 'active', 'oral', '')`,
      )
      .run();

    const { status, body } = await harness.json<RecipeDetailResponse>('/api/recipes/probe_no_steps/recipe');
    expect(status).toBe(200);
    expect(body.recipe.steps).toBe('');
    expect(body.recipe.ingredients).toEqual([]);
  });

  it('多行带序号的步骤原样保留换行（界面才有东西可渲染）', async () => {
    harness = createTestHarness();
    harness.db
      .prepare(
        `INSERT INTO recipes (id, name, kind, effort, status, source, steps)
         VALUES ('probe_steps', '多步菜', 'veg', 'quick', 'active', 'oral', ?)`,
      )
      .run('1. 第一步\n2. 第二步\n3. 第三步');

    const { body } = await harness.json<RecipeDetailResponse>('/api/recipes/probe_steps/recipe');
    expect(body.recipe.steps.split('\n')).toEqual(['1. 第一步', '2. 第二步', '3. 第三步']);
  });

  it('菜谱不存在时报 404（界面能说清是哪一道没找到）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error?: string }>('/api/recipes/没这道菜/recipe');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('退役/草稿菜也能看食谱（历史菜单里可能有它们，「看做法」不该被状态挡住）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<RecipeDetailResponse>('/api/recipes/gongbaojiding/recipe');
    expect(status).toBe(200);
    expect(body.recipe.status).toBe('draft');
    expect(body.recipe.steps.length).toBeGreaterThan(0);
  });
});

describe('营养表的数据资产', () => {
  it('每条营养行都带出处，且四项都非负（逐行 source 是 003 的先例）', async () => {
    harness = createTestHarness();
    const rows = harness.db
      .prepare('SELECT ingredient_id, energy_kcal, protein_g, fat_g, carb_g, source FROM ingredient_nutrition')
      .all() as {
      ingredient_id: string;
      energy_kcal: number;
      protein_g: number;
      fat_g: number;
      carb_g: number;
      source: string;
    }[];

    // 覆盖面：外部池高频项一个不缺
    expect(rows.length).toBeGreaterThanOrEqual(140);
    for (const row of rows) {
      expect(row.source.length, row.ingredient_id).toBeGreaterThan(10);
      for (const value of [row.energy_kcal, row.protein_g, row.fat_g, row.carb_g]) {
        expect(Number.isFinite(value), row.ingredient_id).toBe(true);
        expect(value, row.ingredient_id).toBeGreaterThanOrEqual(0);
      }
    }

    // 高频项（外部池出现次数 top）：抽样钉住「真录了」而不是留空
    for (const id of ['cooking_oil', 'salt', 'light_soy_sauce', 'cooking_wine', 'dark_soy_sauce', 'egg', 'garlic']) {
      expect(rows.some((row) => row.ingredient_id === id), id).toBe(true);
    }
  });

  it('营养行只能指向字典里存在的食材（受控表，不留悬空外键）', () => {
    harness = createTestHarness();
    expect(harness.db.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO ingredient_nutrition (ingredient_id, energy_kcal, protein_g, fat_g, carb_g, source) VALUES ('不存在', 1, 1, 1, 1, 'x')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('删掉食材时它的营养行跟着走（不留悬空数据）', () => {
    harness = createTestHarness();
    harness.db.prepare("INSERT INTO ingredients (id, name) VALUES ('probe_nutri', '探针')").run();
    harness.db
      .prepare(
        "INSERT INTO ingredient_nutrition (ingredient_id, energy_kcal, protein_g, fat_g, carb_g, source) VALUES ('probe_nutri', 100, 1, 1, 1, 'x')",
      )
      .run();

    harness.db.prepare("DELETE FROM ingredients WHERE id = 'probe_nutri'").run();
    expect(
      harness.db.prepare("SELECT COUNT(*) AS n FROM ingredient_nutrition WHERE ingredient_id = 'probe_nutri'").get(),
    ).toEqual({ n: 0 });
  });
});
