import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { parsePromptPool, pickLlmSelection } from '../llm/prompt.js';
import { pickPromotionRewrite } from '../llm/promotion-schema.js';
import type {
  MealRecommendation,
  PromotionListResponse,
  PromotionResponse,
  Recipe,
  ReviewMeal,
  FeedbackListResponse,
} from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 转正流程（总纲 §2.8、spec S6；ADR-0006）在**库这一侧**的行为。
 *
 * 三条要守住的东西：
 *   1. **门槛**：只有「已经上桌」的草稿能转正（判定口径与餐后回顾同源：最后一条非取消事件 +
 *      过了餐次截止时刻）；
 *   2. **改写语义**：口述差异与待重标的 0 克项都落在食材清单上（不做的食材落库时被丢掉），
 *      菜名/别名/来源/锚点这些「身份与不可发明的东西」原样保留；
 *      两种 0 的边界看 `llm/promotion-schema.ts` 的文件头（库里的 0 = 待重标；出参的 0 = 确认不放）；
 *   3. **即时生效**：转正后立刻进推荐池（不需要等任何缓存过期）——这是 S6 的验收句。
 *
 * 时间基准：注入时钟默认 2025-06-01T10:00Z（家庭时区 6/1 18:00）→ 目标餐槽 6/1 晚餐，
 * 晚餐截止 21:00，所以定餐之后要把时钟拨过 6/1 21:00 才是「吃过」。
 */
const SLOT = '2025-06-01:dinner';
const DINNERS = ['mom', 'dad', 'dabao', 'xiaobao'];
/** 外部池里的一道素菜草稿（清炒豆芽：豆芽 + 蒜）——「不放蒜」是它天然可验的差异 */
const EXTERNAL = 'qingchaodouya';
/** 家庭菜谱（已是 active，用来验「不是草稿不能转正」） */
const ACTIVE = 'suanrongcaixin';

function scriptLlm(): void {
  harness.llm.setCompletion((request) => pickPromotionRewrite(request.prompt) ?? pickLlmSelection(request.prompt) ?? '{"dishes":[]}');
}

async function book(slotId = SLOT, dishes: string[] = [EXTERNAL]): Promise<void> {
  const { status, body } = await harness.json(`/api/slots/${slotId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ diners: DINNERS, dishes: dishes.map((recipeId) => ({ recipeId })) }),
  });
  expect(status, JSON.stringify(body)).toBe(200);
}

/** 把时钟拨到某天午餐前（默认 6/2 10:00Z = 家庭时区 6/2 18:00）：6/1 晚餐已成过去 */
function passMeal(): void {
  harness.clock.set('2025-06-02T10:00:00.000Z');
}

async function promote(
  recipeId = EXTERNAL,
  payload: unknown = {},
): Promise<{ status: number; body: PromotionResponse & { error?: string; status?: string; notes?: string[] } }> {
  return harness.json(`/api/recipes/${recipeId}/promotion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function getRecipe(id: string): Promise<Recipe> {
  const { status, body } = await harness.json<{ recipe: Recipe }>(`/api/recipes/${id}`);
  expect(status).toBe(200);
  return body.recipe;
}

async function reviewMeals(): Promise<ReviewMeal[]> {
  const { status, body } = await harness.json<FeedbackListResponse>('/api/feedback');
  expect(status).toBe(200);
  return body.meals;
}

describe('转正门槛（ADR-0006：家里做过、家人吃过）', () => {
  it('还没上过桌的草稿不能转正（400 recipe_not_served），库一个字节没动', async () => {
    harness = createTestHarness();
    scriptLlm();

    const before = await getRecipe(EXTERNAL);
    const { status, body } = await promote(EXTERNAL, { differences: '不放蒜' });
    expect(status).toBe(400);
    expect(body.error).toBe('recipe_not_served');

    // 没调用 LLM（门槛在改写之前就挡住了），草稿原样
    expect(harness.llm.completionCalls).toHaveLength(0);
    const after = await getRecipe(EXTERNAL);
    expect(after.status).toBe('draft');
    expect(after).toEqual(before);
  });

  it('被预定但还没到截止时刻的不算吃过（上桌 = 过了餐次截止）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();

    // 6/1 18:00：晚餐已定、还没到 21:00 截止 → 还没上桌
    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(400);
    expect(body.error).toBe('recipe_not_served');
  });

  it('改餐把这道菜换掉了就不算吃过（只认最后一条事件）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    // 改餐：把清炒豆芽换成家庭菜谱——最后一条事件里没有它了
    const changed = await harness.json(`/api/slots/${SLOT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: DINNERS, dishes: [{ recipeId: ACTIVE }] }),
    });
    expect(changed.status).toBe(200);
    passMeal();

    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(400);
    expect(body.error).toBe('recipe_not_served');
  });

  it('上桌过之后能转正（与上一条同一判定口径的对照组）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.promotion.recipe.status).toBe('active');
  });

  it('取消掉那一餐之后不算吃过（取消把餐槽退回未定）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    const cancelled = await harness.json(`/api/slots/${SLOT}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    passMeal();

    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(400);
    expect(body.error).toBe('recipe_not_served');
  });

  it('已经是家庭菜谱 / 已退役的不能转正（409 not_draft）', async () => {
    harness = createTestHarness();
    scriptLlm();

    const active = await promote(ACTIVE);
    expect(active.status).toBe(409);
    expect(active.body.error).toBe('not_draft');
    expect(active.body.status).toBe('active');

    // 种子里退役的那道（香煎带鱼）同样不能转正
    const retired = await promote('xiangjiandaiyu');
    expect(retired.status).toBe(409);
    expect(retired.body.error).toBe('not_draft');
    expect(retired.body.status).toBe('retired');
  });

  it('不存在的菜谱 404（与 GET /recipes/:id 同一个错误码）', async () => {
    harness = createTestHarness();
    const { status, body } = await promote('meiyouzhedaocai');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('成员 id 对不上家人列表 → 400 unknown_member（不写一条无主的台账）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL, { memberId: 'linshi' });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_member');
    expect(harness.llm.completionCalls).toHaveLength(0);
    expect((await getRecipe(EXTERNAL)).status).toBe('draft');
  });
});

describe('改写：口述差异落在食材清单上（总纲 §2.8）', () => {
  it('改写后字段完备：荤素位/难度/口味/时令/做法/食材都在（AC：字段完备性）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL, { differences: '不放蒜' });
    expect(status).toBe(200);
    const recipe = body.promotion.recipe;
    // 成人份基准体系与字段完备性（AC 第二条）：改写后仍是一份完整可用的家庭菜谱
    expect(['meat', 'veg', 'soup_meat', 'soup_veg']).toContain(recipe.kind);
    expect(['quick', 'medium', 'heavy']).toContain(recipe.effort);
    expect(recipe.tastes.length).toBeGreaterThan(0);
    expect(recipe.steps.trim()).not.toBe('');
    expect(recipe.ingredients.length).toBeGreaterThan(0);
    expect(recipe.ingredients.every((item) => item.adultGrams > 0)).toBe(true);
    expect(recipe.ingredients.every((item) => ['linear', 'fixed'].includes(item.scaling))).toBe(true);
    // 忌口推导跟着新清单重算（蒜不在清单里了，豆芽在）
    expect(recipe.avoidIngredientIds).toContain('bean_sprouts');
    expect(recipe.avoidIngredientIds).not.toContain('garlic');
  });

  it('缩放规则与生熟换算锚点从原项继承（模型不发明锚点，AC：保留基准体系）', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 给豆芽加上锚点：转正后它必须原样还在（那是 WS/T 554 的引用，不是模型能写的）
    harness.db
      .prepare("UPDATE recipe_ingredients SET raw_cooked_anchor = '豆芽 100g ≈ 焯水后 90g' WHERE recipe_id = ? AND ingredient_id = 'bean_sprouts'")
      .run(EXTERNAL);
    await book();
    passMeal();

    const { body } = await promote(EXTERNAL, { differences: '多放豆芽' });
    const sprout = body.promotion.recipe.ingredients.find((item) => item.name === '豆芽')!;
    expect(sprout.rawCookedAnchor).toBe('豆芽 100g ≈ 焯水后 90g');
    const garlic = body.promotion.recipe.ingredients.find((item) => item.name === '蒜')!;
    expect(garlic.scaling).toBe('fixed');
  });

  it('「不放蒜」把蒜去掉、其余保留；状态翻到 active，来源与菜名不变', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const before = await getRecipe(EXTERNAL);
    const { status, body } = await promote(EXTERNAL, { differences: '不放蒜', memberId: 'mom' });
    expect(status).toBe(200);

    const recipe = body.promotion.recipe;
    expect(recipe.status).toBe('active');
    expect(recipe.id).toBe(EXTERNAL);
    // 身份不变：转正改的是做法，不是「这道菜从哪来」
    expect(recipe.name).toBe(before.name);
    expect(recipe.source).toBe('howtocook');
    expect(recipe.aliases).toEqual(before.aliases);
    // 蒜没了（出参里的 0 = 确认不放，落库时该项被丢掉），豆芽还在且是正数
    expect(recipe.ingredients.map((item) => item.name)).toEqual(['豆芽']);
    expect(recipe.ingredients[0]!.adultGrams).toBeGreaterThan(0);
    // LLM 元数据是这一路的模板版本（不是推荐模板）
    expect(body.promotion.llm.promptVersion).toBe('2026-09-promotion-v1');
    expect(body.promotion.llm.model).toBe('fake-llm');
    expect(body.promotion.llm.degraded).toBe(false);
  });

  it('「多放蒜」把克数调上去（fake 的 ×1.5 规则），克数仍落在合理区间', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const before = await getRecipe(EXTERNAL);
    const beforeGarlic = before.ingredients.find((item) => item.name === '蒜')!.adultGrams;
    const { status, body } = await promote(EXTERNAL, { differences: '多点蒜' });
    expect(status).toBe(200);

    const afterGarlic = body.promotion.recipe.ingredients.find((item) => item.name === '蒜')!.adultGrams;
    expect(afterGarlic).toBeGreaterThan(beforeGarlic);
  });

  it('「多点辣」补口味标签；口味与适季月份不改时保持原值', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const before = await getRecipe(EXTERNAL);
    expect(before.tastes).toEqual(['清淡']);
    const { body } = await promote(EXTERNAL, { differences: '多点辣' });
    expect(body.promotion.recipe.tastes).toContain('辣');
    expect(body.promotion.recipe.tastes).toContain('清淡');
    // 改写没动适季月份（fake 沿用输入）→ 与原值相同
    expect(body.promotion.recipe.seasonMonths).toEqual(before.seasonMonths);
  });

  it('掌勺者校对的菜系压过 LLM 的判断（总纲 §2.8：转正时校 tag）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    // 种子里清炒豆芽是「家常」；掌勺者改成「粤」→ 落库就是粤
    const before = await getRecipe(EXTERNAL);
    expect(before.cuisine).toBe('家常');
    const { body } = await promote(EXTERNAL, { cuisine: '粤' });
    expect(body.promotion.recipe.cuisine).toBe('粤');

    // 台账记下了前后值（「从什么改成什么」是留痕的一半）
    const { body: ledger } = await harness.json<PromotionListResponse>(`/api/recipes/${EXTERNAL}/promotions`);
    expect(ledger.promotions).toHaveLength(1);
    expect(ledger.promotions[0]).toMatchObject({ cuisineFrom: '家常', cuisineTo: '粤' });
  });

  it('值域外的菜系被 400 挡在门口（invalid_request），不落一条脏 tag', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL, { cuisine: '京菜' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect((await getRecipe(EXTERNAL)).status).toBe('draft');
  });

  it('口述差异超长被 400 挡下（超过 500 字）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL, { differences: '辣'.repeat(501) });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    // 拦下 = 没调用 LLM、没动库（不是「默默截断前 500 字再往下走」）
    expect(harness.llm.completionCalls).toHaveLength(0);
    expect((await getRecipe(EXTERNAL)).status).toBe('draft');
  });

  it('正好 500 字的口述差异原样进 prompt（长度只有一道门槛，不静默截断）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    // 上限内的输入必须一字不差地到达改写（领域层不再 slice 一次——那会变成不可达的第二道闸）
    const differences = '多放点辣椒'.repeat(100);
    expect(differences).toHaveLength(500);
    const { status } = await promote(EXTERNAL, { differences });
    expect(status).toBe(200);
    expect(harness.llm.completionCalls[0]!.request.prompt).toContain(differences);
    // 台账记的是同一份原文（不是被截过的）
    const { body: ledger } = await harness.json<PromotionListResponse>(`/api/recipes/${EXTERNAL}/promotions`);
    expect(ledger.promotions[0]!.differences).toBe(differences);
  });
});

describe('待重标项（0 克）在转正时被重标（#19 台账点名留给 #21 的收口）', () => {
  it('导入的 0 克草稿转正后没有 0 克项（转正不会把未定固化成家庭基准）', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 造一道 0 克的草稿：把清炒豆芽的蒜改成 0 克（模糊份量等重标的存储形态）
    harness.db
      .prepare("UPDATE recipe_ingredients SET adult_grams = 0, source_quantity = '适量' WHERE recipe_id = ? AND ingredient_id = 'garlic'")
      .run(EXTERNAL);
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(200);
    const ingredients = body.promotion.recipe.ingredients;
    expect(ingredients.every((item) => item.adultGrams > 0)).toBe(true);
    // fake 的兜底克数（蒜 → 6g）落库，而不是 0
    expect(ingredients.find((item) => item.name === '蒜')!.adultGrams).toBeGreaterThan(0);
    // 重标后的项不再是「待重标」（relabel 覆盖率的分母只算草稿，这里已经没有草稿了）
    // 只看这道菜：008 的种子里还有另一道待重标的草稿（本票自己的 `pending_relabel_ribs`）
    const pending = harness.db
      .prepare(
        "SELECT COUNT(*) AS n FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id WHERE r.id = ? AND ri.adult_grams <= 0",
      )
      .get(EXTERNAL) as { n: number };
    expect(pending.n).toBe(0);
  });

  it('改写把待重标项又写成 0 → 整次失败（502），草稿与库都原样', async () => {
    harness = createTestHarness();
    // 一个「不听话」的 fake：把所有食材都写成 0（这正是「转正会把未定固化成没有」的坏输出）
    harness.llm.setCompletion(() => JSON.stringify({ kind: 'veg', effort: 'quick', tastes: [], ingredients: [{ name: '豆芽', grams: 0 }, { name: '蒜', grams: 0 }] }));
    harness.db
      .prepare("UPDATE recipe_ingredients SET adult_grams = 0 WHERE recipe_id = ? AND ingredient_id = 'garlic'")
      .run(EXTERNAL);
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(502);
    expect(body.error).toBe('rewrite_failed');
    expect((await getRecipe(EXTERNAL)).status).toBe('draft');
    // 失败时没有台账（没发生的事不留痕）
    const { body: ledger } = await harness.json<PromotionListResponse>(`/api/recipes/${EXTERNAL}/promotions`);
    expect(ledger.promotions).toHaveLength(0);
  });
});

describe('改写失败与出参校验（不改半截：失败就整次失败）', () => {
  it('LLM 调用失败 → 502 rewrite_failed，状态与食材原样，台账为空', async () => {
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可达'));
    await book();
    passMeal();

    const before = await getRecipe(EXTERNAL);
    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(502);
    expect(body.error).toBe('rewrite_failed');
    expect(body.notes?.length).toBeGreaterThan(0);
    expect(await getRecipe(EXTERNAL)).toEqual(before);
    // 重试了两次（maxAttempts 缺省 2），而不是一次就放弃
    expect(harness.llm.completionCalls).toHaveLength(2);
  });

  it('出参漏掉原有食材 / 多出陌生食材 → 502（名字对不上就写不到字典项上）', async () => {
    harness = createTestHarness();
    harness.llm.setCompletion(() =>
      JSON.stringify({ kind: 'veg', effort: 'quick', tastes: [], ingredients: [{ name: '豆芽', grams: 160 }, { name: '花椒', grams: 3 }] }),
    );
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(502);
    expect(body.error).toBe('rewrite_failed');
    expect((await getRecipe(EXTERNAL)).status).toBe('draft');
  });

  it('第一次形状不合、第二次对了 → 成功（重试是转正路径的一部分）', async () => {
    harness = createTestHarness();
    harness.llm.queueCompletion('不是 JSON');
    harness.llm.setCompletion((request) => pickPromotionRewrite(request.prompt)!);
    await book();
    passMeal();

    const { status, body } = await promote(EXTERNAL);
    expect(status).toBe(200);
    expect(body.promotion.recipe.status).toBe('active');
    expect(body.promotion.notes.join('')).toMatch(/形状不合/);
  });
});

describe('S6：转正后即时进家庭库与推荐池', () => {
  it('转正过的菜进推荐池且 origin 是 family（不是「没做过」的外部补位）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();
    const { status } = await promote(EXTERNAL);
    expect(status).toBe(200);

    // 去重窗口是 7 天（总纲 §4）：转正那天它刚好被吃过，得等出窗口再问下一次推荐
    harness.clock.set('2025-06-10T10:00:00.000Z');
    const { status: recStatus, body } = await harness.json<{ recommendation: MealRecommendation }>(
      '/api/slots/2025-06-10:dinner/recommendation',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(recStatus).toBe(200);
    // 池子进 prompt 是确定的事实（ADR-0001）：转正后的它在池里，且已不是「外部（没做过）」
    const pool = parsePromptPool(harness.llm.completionCalls.at(-1)!.request.prompt);
    const entry = pool.find((item) => item.id === EXTERNAL);
    expect(entry).toBeDefined();
    expect(entry!.origin).toBe('family');
    expect(body.recommendation.dishes.length).toBeGreaterThan(0);

    // 而外部池里少了一道（草稿池 = 还没转正的那些）
    const { body: drafts } = await harness.json<{ recipes: Recipe[] }>('/api/recipes?status=draft');
    expect(drafts.recipes.map((recipe) => recipe.id)).not.toContain(EXTERNAL);
    const { body: actives } = await harness.json<{ recipes: Recipe[] }>('/api/recipes?status=active');
    expect(actives.recipes.map((recipe) => recipe.id)).toContain(EXTERNAL);
  });

  it('转正后的改写真的进了买菜单价：份量引擎算出来的克数就是改写后的基准', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();
    const { body } = await promote(EXTERNAL, { differences: '不放蒜' });
    const rewritten = body.promotion.recipe.ingredients[0]!.adultGrams;

    // 用改写后的菜谱再定一餐（6/2 晚餐还没过截止），份量明细里的成人份基准 = 改写值
    const { status } = await harness.json('/api/slots/2025-06-02:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: EXTERNAL }] }),
    });
    expect(status).toBe(200);
    const { body: slot } = await harness.json<{ slot: { portion: { dishes: { ingredients: { name: string; adultGrams: number }[] }[] } } }>(
      '/api/slots/2025-06-02:dinner',
    );
    const item = slot.slot.portion.dishes[0]!.ingredients.find((entry) => entry.name === '豆芽')!;
    expect(item.adultGrams).toBe(rewritten);
    // 不放蒜之后蒜根本不在份量明细里（0 克项没有进库）
    expect(slot.slot.portion.dishes[0]!.ingredients.map((entry) => entry.name)).not.toContain('蒜');
  });
});

describe('餐后回顾里的转正入口（spec S6 的落点）', () => {
  it('吃过的那一餐在回顾里，草稿菜在其中（界面据此摆出「转正」表单）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    // 餐前：没有回顾卡（还没到截止）
    expect(await reviewMeals()).toEqual([]);
    passMeal();

    const meals = await reviewMeals();
    expect(meals.map((meal) => meal.slotId)).toEqual([SLOT]);
    expect(meals[0]!.dishes.map((dish) => dish.recipeId)).toEqual([EXTERNAL]);
    // 界面拿它去 `GET /recipes/:id` 拿 status/cuisine/食材，决定摆不摆转正表单
    const recipe = await getRecipe(EXTERNAL);
    expect(recipe.status).toBe('draft');
    expect(recipe.ingredients.some((item) => item.adultGrams <= 0)).toBe(false);
  });
});

describe('台账（总纲 §2.8「编辑留痕」）', () => {
  it('记下谁按谁的口述改的、菜系前后值、LLM 元数据（模板版本可回溯）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();

    const { status } = await promote(EXTERNAL, { differences: '不放蒜、多点辣', memberId: 'mom', cuisine: '家常' });
    expect(status).toBe(200);

    const { body } = await harness.json<PromotionListResponse>(`/api/recipes/${EXTERNAL}/promotions`);
    expect(body.promotions).toHaveLength(1);
    const record = body.promotions[0]!;
    expect(record.recipeId).toBe(EXTERNAL);
    expect(record.memberId).toBe('mom');
    expect(record.memberName).toBe('妈妈');
    expect(record.differences).toBe('不放蒜、多点辣');
    expect(record.cuisineTo).toBe('家常');
    expect(record.llmModel).toBe('fake-llm');
    expect(record.llmPromptVersion).toBe('2026-09-promotion-v1');
    expect(record.promotedAt).toBe('2025-06-02T10:00:00.000Z');
  });

  it('没口述差异也留一条（差异是空串）：台账回答的是「谁什么时候转的」，不只有「改了什么」', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();
    await promote(EXTERNAL);

    const { body } = await harness.json<PromotionListResponse>(`/api/recipes/${EXTERNAL}/promotions`);
    expect(body.promotions[0]).toMatchObject({ differences: '', memberId: null, memberName: null });
  });

  it('同一道菜只能转正一次（第二次 409）；台账按路径取，不存在的菜 404', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    passMeal();
    expect((await promote(EXTERNAL)).status).toBe(200);

    const second = await promote(EXTERNAL);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('not_draft');

    const missing = await harness.json(`/api/recipes/meiyouzhedaocai/promotions`);
    expect(missing.status).toBe(404);
  });
});
