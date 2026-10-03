import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import type { Ingredient as IngredientJson, MenuNutrition } from '../wire-types.js';
import { NUTRITION_NO_ESTIMATE_PROBE, pickNutritionEstimate } from '../llm/nutrition-estimate-schema.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 估算营养（CONTEXT「估算营养」；ADR-0013；issue #38）在**服务端写路径**上的行为。
 *
 * 三条不变量在这里守：
 * 1. **预填而非写入**：提议路由一个字节都不落库（点「估算营养」之后字典里没有营养行）。
 * 2. **source 自证是估算**：落库行的 source 含模型标识与参照的成分表条目，且**与成分表读数靠
 *    source 区分**（ADR-0013「决定一」：不加第二列、不加第二表）。
 * 3. **成分表读数不许被估算覆盖**：已有非估算行时写入 → 明确报错（**不是静默忽略**）。
 *
 * 与其余 API 测试同口径：只断言外部可见行为（HTTP 形状与数字），不查表结构。
 */

async function listIngredients(query = ''): Promise<IngredientJson[]> {
  const { body } = await harness.json<{ ingredients: IngredientJson[] }>(`/api/ingredients${query}`);
  return body.ingredients;
}

async function createIngredient(body: unknown): Promise<{
  status: number;
  body: {
    ingredient?: IngredientJson;
    error?: string;
    issues?: { path: string; message: string }[];
    ingredientId?: string;
  };
}> {
  return harness.json('/api/ingredients', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function nutritionSuggestion(body: unknown): Promise<{
  status: number;
  body: {
    estimate?: { energyKcal: number; proteinG: number; fatG: number; carbG: number; reference: { ingredientId: string; name: string } };
    degraded?: boolean;
    model?: string;
    error?: string;
    issues?: { path: string; message: string }[];
  };
}> {
  return harness.json('/api/ingredients/nutrition-suggestion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchIngredient(id: string, body: unknown): Promise<{
  status: number;
  body: { ingredient?: IngredientJson; error?: string; ingredientId?: string; issues?: { path: string; message: string }[] };
}> {
  return harness.json(`/api/ingredients/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `GET /api/ingredients/:id/edits`：该食材的改动台账 */
async function ingredientEditsOf(id: string): Promise<{ edits: { changedFields: string[] }[] }> {
  const { body } = await harness.json<{ edits: { changedFields: string[] }[] }>(`/api/ingredients/${id}/edits`);
  return body;
}

/** 直读营养行（读接口只有「每餐营养」那一侧；单条食材的营养行目前只经这个探针读） */
function nutritionRow(id: string): { energy_kcal: number; source: string } | undefined {
  return harness.db
    .prepare('SELECT energy_kcal, source FROM ingredient_nutrition WHERE ingredient_id = ?')
    .get(id) as { energy_kcal: number; source: string } | undefined;
}

/** 让 fake 走「估算营养」这条确定性路径（与 E2E 服务端同一分发） */
function useFakeEstimate(): void {
  harness.llm.setCompletion((request) => pickNutritionEstimate(request.prompt) ?? '{"estimate":null}');
}

describe('估算营养：提议（预填而非写入）', () => {
  it('候选池来自成分表读数，估出的四项 + 参照条目都是池内的（可回查）', async () => {
    harness = createTestHarness();
    useFakeEstimate();

    const { status, body } = await nutritionSuggestion({ name: '38-蚝油' });
    expect(status).toBe(200);
    expect(body.degraded).toBe(false);
    expect(body.estimate).toBeDefined();
    // 参照条目必须是字典里**真有读数**的那一条（fake 挑「酱油(均值)」——字典 id 是 `light_soy`）
    expect(body.estimate!.reference).toEqual({ ingredientId: 'light_soy', name: '酱油(均值)' });
    // 四项是数字（可复算：界面预填的就是它们）
    expect(body.estimate!.energyKcal).toBeGreaterThan(0);
    expect(body.estimate!.proteinG).toBeGreaterThanOrEqual(0);

    // 池子确实来自成分表读数：prompt 里带上了既有条目的读数（不只是名字）
    const prompt = harness.llm.completionCalls.at(-1)!.request.prompt;
    expect(prompt).toContain('酱油(均值)');
    expect(prompt).toContain('猪大排');
  });

  it('提议不落库：调用之后字典里没有新条目、也没有新的营养行', async () => {
    harness = createTestHarness();
    useFakeEstimate();

    const before = harness.db.prepare('SELECT COUNT(*) AS n FROM ingredient_nutrition').get() as { n: number };
    const created = await createIngredient({ name: '38-提议不落库' });
    const id = created.body.ingredient!.id;

    const { body } = await nutritionSuggestion({ name: '38-提议不落库' });
    expect(body.estimate).toBeDefined();

    // 这条食材还没有营养行（预填而非写入）
    expect(nutritionRow(id)).toBeUndefined();
    const after = harness.db.prepare('SELECT COUNT(*) AS n FROM ingredient_nutrition').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('LLM 不可用 → 200 + degraded: true + 无估算（不报错）', async () => {
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可达'));

    const { status, body } = await nutritionSuggestion({ name: '38-蚝油' });
    expect(status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.estimate).toBeUndefined();
  });

  it('两种空是两条不同的响应：AI 估不出来（degraded: false）vs AI 用不了（degraded: true）', async () => {
    harness = createTestHarness();
    useFakeEstimate();
    // 探针：名字含「估不出」→ fake 回 {"estimate":null}
    const noEstimate = await nutritionSuggestion({ name: `38-${NUTRITION_NO_ESTIMATE_PROBE}的东西` });

    harness.close();
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可达'));
    const degraded = await nutritionSuggestion({ name: `38-${NUTRITION_NO_ESTIMATE_PROBE}的东西` });

    expect(noEstimate.body.estimate).toBeUndefined();
    expect(degraded.body.estimate).toBeUndefined();
    expect(noEstimate.body.degraded).toBe(false);
    expect(degraded.body.degraded).toBe(true);
    expect(noEstimate.body).not.toEqual(degraded.body);
  });

  it('名字空 / 纯空白 → 400（没有可估算的对象）', async () => {
    harness = createTestHarness();
    useFakeEstimate();

    const empty = await nutritionSuggestion({ name: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('invalid_request');

    const missing = await nutritionSuggestion({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_request');
  });
});

describe('估算营养：落库（人确认之后）', () => {
  it('录入时带四项 → 落一行，source 自证是估算（含模型标识与参照条目）', async () => {    harness = createTestHarness();
    useFakeEstimate();

    const suggestion = await nutritionSuggestion({ name: '38-蚝油' });
    const estimate = suggestion.body.estimate!;
    const created = await createIngredient({
      name: '38-蚝油',
      nutrition: {
        energyKcal: estimate.energyKcal,
        proteinG: estimate.proteinG,
        fatG: estimate.fatG,
        carbG: estimate.carbG,
        reference: estimate.reference.ingredientId,
      },
    });
    expect(created.status).toBe(201);

    const row = nutritionRow(created.body.ingredient!.id);
    expect(row).toBeDefined();
    expect(row!.energy_kcal).toBe(estimate.energyKcal);
    // 自证是估算：固定前缀 + 模型标识 + 参照的成分表条目
    expect(row!.source).toContain('LLM 估算');
    expect(row!.source).toContain('fake-llm');
    expect(row!.source).toContain('酱油(均值)');
    // 与成分表读数靠 source 区分（012 那批行的 source 里没有这个前缀）
    expect(row!.source).not.toContain('食物营养成分查询平台');
  });

  it('改食材时四项没动就不算一次改动（不写空台账）', async () => {
    harness = createTestHarness();


    // 先建一条带估算营养的食材
    const created = await createIngredient({
      name: '38-四项没动',
      nutrition: { energyKcal: 100, proteinG: 1, fatG: 1, carbG: 1, reference: 'light_soy' },
    });
    const id = created.body.ingredient!.id;
    expect((await ingredientEditsOf(id)).edits).toEqual([]);

    // 原样再提交一次同样的四项：不是一次改动（与其它四个字段同一口径）
    const same = await patchIngredient(id, {
      nutrition: { energyKcal: 100, proteinG: 1, fatG: 1, carbG: 1, reference: 'light_soy' },
    });
    expect(same.status).toBe(409);
    expect(same.body.error).toBe('no_changes');
    expect((await ingredientEditsOf(id)).edits).toEqual([]);

    // 真改了一个数 → 记一笔，字段列里有 nutrition
    const changed = await patchIngredient(id, {
      nutrition: { energyKcal: 101, proteinG: 1, fatG: 1, carbG: 1, reference: 'light_soy' },
    });
    expect(changed.status).toBe(200);
    const edits = (await ingredientEditsOf(id)).edits;
    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedFields).toEqual(['nutrition']);
  });

  it('只改四项（不改别的字段）也算一次改动，且台账里写的是 nutrition', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '38-只改营养' });
    const id = created.body.ingredient!.id;
    const patched = await patchIngredient(id, {
      nutrition: { energyKcal: 50, proteinG: 1, fatG: 1, carbG: 1, reference: 'light_soy' },
    });
    expect(patched.status).toBe(200);
    expect((await ingredientEditsOf(id)).edits[0]!.changedFields).toEqual(['nutrition']);
  });

  it('人改过的数字落库的就是人改的那个（预填不是决定）', async () => {
    harness = createTestHarness();
    useFakeEstimate();

    const created = await createIngredient({
      name: '38-改过数字',
      nutrition: { energyKcal: 111.1, proteinG: 2.2, fatG: 3.3, carbG: 4.4, reference: 'light_soy_sauce' },
    });
    expect(created.status).toBe(201);

    const row = nutritionRow(created.body.ingredient!.id);
    expect(row!.energy_kcal).toBe(111.1);
    expect(row!.source).toContain('酱油(均值)');
  });

  it('不带 nutrition → 照旧能录（缺营养是既有的合法状态，不拦保存）', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '38-没填营养' });
    expect(created.status).toBe(201);
    expect(nutritionRow(created.body.ingredient!.id)).toBeUndefined();
  });

  it('只有部分项有值 → 400（不半真半假地进合计）', async () => {
    harness = createTestHarness();

    const partial = await createIngredient({
      name: '38-半真半假',
      nutrition: { energyKcal: 100, proteinG: 1 },
    });
    expect(partial.status).toBe(400);
    expect(partial.body.error).toBe('invalid_request');
    // 明确说清是「四项要么全给、要么不给」
    expect(partial.body.issues?.[0]?.message).toMatch(/四项/);
    // 半截行也没落进去
    expect(await listIngredients('?q=38-半真半假')).toEqual([]);
  });

  it('参照条目不在成分表读数里 → 400，不静默忽略（出处不能是编的）', async () => {
    harness = createTestHarness();

    const unknown = await createIngredient({
      name: '38-瞎指参照',
      nutrition: { energyKcal: 100, proteinG: 1, fatG: 1, carbG: 1, reference: '成分表里没有这条' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('unknown_nutrition_reference');
    expect(unknown.body.ingredientId).toBe('成分表里没有这条');

    // 指向一条**没有读数**的字典条目（如蚝油）同样拒收：参照必须是真读数
    const noReading = await createIngredient({
      name: '38-指向没读数的',
      nutrition: { energyKcal: 100, proteinG: 1, fatG: 1, carbG: 1, reference: 'oyster_sauce' },
    });
    expect(noReading.status).toBe(400);
    expect(noReading.body.error).toBe('unknown_nutrition_reference');
  });

  it('负数 / 非有限值 → 400（不是营养读数）', async () => {
    harness = createTestHarness();

    const negative = await createIngredient({
      name: '38-负数',
      nutrition: { energyKcal: -1, proteinG: 1, fatG: 1, carbG: 1, reference: 'light_soy_sauce' },
    });
    expect(negative.status).toBe(400);
    expect(negative.body.error).toBe('invalid_request');
  });
});

describe('估算营养：成分表读数不许被估算覆盖（ADR-0013 决定三）', () => {
  it('给已有读数的食材写估算 → 409 明确报错，且读数一个字节没变', async () => {
    harness = createTestHarness();

    const before = nutritionRow('light_soy_sauce')!;
    const { status, body } = await patchIngredient('light_soy_sauce', {
      nutrition: { energyKcal: 999, proteinG: 9, fatG: 9, carbG: 9, reference: 'pork_ribs' },
    });
    expect(status).toBe(409);
    expect(body.error).toBe('nutrition_locked');
    expect(body.ingredientId).toBe('light_soy_sauce');
    // 读数没被改写（不是「静默忽略」：既有行原样，响应明确说了原因）
    expect(nutritionRow('light_soy_sauce')).toEqual(before);
  });

  it('估算行可以被人再改一次（重估或手改都不算「覆盖读数」）', async () => {
    harness = createTestHarness();
    useFakeEstimate();

    const created = await createIngredient({
      name: '38-可重估',
      nutrition: { energyKcal: 100, proteinG: 1, fatG: 1, carbG: 1, reference: 'light_soy_sauce' },
    });
    const id = created.body.ingredient!.id;

    const patched = await patchIngredient(id, {
      nutrition: { energyKcal: 120, proteinG: 2, fatG: 2, carbG: 2, reference: 'light_soy_sauce' },
    });
    expect(patched.status).toBe(200);
    expect(nutritionRow(id)!.energy_kcal).toBe(120);
    expect(nutritionRow(id)!.source).toContain('LLM 估算');
  });

  it('水那两条定义性零点不算「成分表读数」，但也不该被估算改写（它们是定义）', async () => {
    harness = createTestHarness();

    const { status, body } = await patchIngredient('water', {
      nutrition: { energyKcal: 10, proteinG: 1, fatG: 1, carbG: 1, reference: 'light_soy_sauce' },
    });
    // 水没有「LLM 估算」前缀 → 与读数同样受保护（本票不改定义性零点）
    expect(status).toBe(409);
    expect(body.error).toBe('nutrition_locked');
  });
});

describe('估算营养：读数口径（含估算的合计要说得出来）', () => {
  it('估算行进合计，并被单独点名（`estimatedIngredients`），与缺数据分开报', async () => {
    harness = createTestHarness();
    useFakeEstimate();

    // 一条估算食材 + 一道用它做的菜
    const created = await createIngredient({
      name: '38-估算食材',
      nutrition: { energyKcal: 100, proteinG: 10, fatG: 1, carbG: 2, reference: 'light_soy_sauce' },
    });
    const id = created.body.ingredient!.id;
    harness.db
      .prepare(
        `INSERT INTO recipes (id, name, kind, effort, status, source, steps)
         VALUES ('probe_estimated', '估算探针菜', 'veg', 'quick', 'active', 'oral', '')`,
      )
      .run();
    harness.db
      .prepare(
        `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, position, adult_grams, scaling)
         VALUES ('probe_estimated', ?, 0, 200, 'linear')`,
      )
      .run(id);

    await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'probe_estimated' }] }),
    });
    const { body } = await harness.json<{ nutrition: MenuNutrition }>('/api/slots/2025-06-01:dinner/nutrition');
    const nutrition = body.nutrition;

    // 估算项进合计：200 g × 100 kcal/100 g = 200 kcal
    expect(nutrition.energyKcal).toBeCloseTo(200, 1);
    // 单独点名（措辞是「这几项是估算的，数字是参考」，不是「没算进合计」）
    expect(nutrition.estimatedIngredients).toEqual([{ ingredientId: id, name: '38-估算食材' }]);
    expect(nutrition.missingIngredients).toEqual([]);
    // 合计不是全由读数构成 → partial 为真，但这一道**没有**缺数据
    expect(nutrition.partial).toBe(true);
    const dish = nutrition.dishes[0]!;
    expect(dish.estimated).toBe(true);
    expect(dish.missing).toBe(false);
    // 含估算的读数上那句「食材营养取《中国食物成分表》平均值」是假话 → 换一种措辞
    expect(nutrition.nutritionSource).toContain('估算');
    expect(nutrition.nutritionSource).not.toContain('平均值');
  });

  it('全是读数时措辞不变（原句保留，且 estimatedIngredients 为空、partial 为假）', async () => {
    harness = createTestHarness();
    await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    const { body } = await harness.json<{ nutrition: MenuNutrition }>('/api/slots/2025-06-01:dinner/nutrition');

    expect(body.nutrition.estimatedIngredients).toEqual([]);
    expect(body.nutrition.partial).toBe(false);
    expect(body.nutrition.nutritionSource).toContain('《中国食物成分表》');
  });
});
