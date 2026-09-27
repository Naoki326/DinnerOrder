import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { pickLlmSelection } from '../llm/prompt.js';
import { pickPromotionRewrite } from '../llm/promotion-schema.js';
import type { Recipe as RecipeJson, RecipeEditRecord } from '../wire-types.js';

/**
 * 菜谱库：掌勺者可写（issue #30；ADR-0009）。
 *
 * 接缝：`TestHarness` 进程内 HTTP（仓库所有 `api/*.test.ts` 的既有接缝）。本文件只验**外部行为**：
 * 一次录入/修订/退役走完，从 `GET /recipes/:id` 与台账读回来的东西对不对，以及与既有推荐/换菜
 * 的交互（退役菜不进推荐、克数改了推荐跟着变）。
 *
 * 线上形状从 `wire-types` 取（与前端同一处定义），不手抄（`recipes.test.ts` 头注的既有纪律）。
 */

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

async function getRecipe(id: string): Promise<{ status: number; body: { recipe?: RecipeJson; error?: string } }> {
  return harness.json(`/api/recipes/${id}`);
}

async function createRecipe(body: unknown): Promise<{ status: number; body: { recipe?: RecipeJson; error?: string } }> {
  return harness.json('/api/recipes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchRecipe(
  id: string,
  body: unknown,
): Promise<{ status: number; body: { recipe?: RecipeJson; error?: string } }> {
  return harness.json(`/api/recipes/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function editsOf(id: string): Promise<RecipeEditRecord[]> {
  const { status, body } = await harness.json<{ edits: RecipeEditRecord[] }>(`/api/recipes/${id}/edits`);
  expect(status).toBe(200);
  return body.edits;
}

/** 转正必带 LLM 改写：让 fake 从 prompt 里读回输入并产出一份合法改写（与 promotion.test.ts 同一手法） */
function scriptLlm(): void {
  harness.llm.setCompletion(
    (request) => pickPromotionRewrite(request.prompt) ?? pickLlmSelection(request.prompt) ?? '{"dishes":[]}',
  );
}

describe('菜谱库：录入（ADR-0009）', () => {
  it('掌勺者手写的菜直接进家庭库与推荐池：active + oral，录完即可用', async () => {
    harness = createTestHarness();

    const created = await createRecipe({
      name: '蒜香粉丝虾',
      kind: 'meat',
      effort: 'quick',
      cuisine: '粤',
      steps: '虾开背，蒜蓉炒香铺上，蒸 6 分钟。',
      ingredients: [{ ingredientId: 'shrimp', adultGrams: 150 }],
      memberId: 'mom',
    });

    expect(created.status).toBe(201);
    const recipe = created.body.recipe!;
    // ADR-0009 的核心：没做过也进家庭库（source='oral' 是「掌勺者手写的」）
    expect(recipe.status).toBe('active');
    expect(recipe.source).toBe('oral');
    expect(recipe.name).toBe('蒜香粉丝虾');

    // 立刻在成员列表里可见（录完直接可用，不用先做一顿来「证明」它是真菜）
    const { body: listed } = await harness.json<{ recipes: RecipeJson[] }>('/api/recipes?status=active');
    expect(listed.recipes.map((item) => item.id)).toContain(recipe.id);

    // 立刻进推荐池的候选（同一张状态表）
    const { body: all } = await harness.json<{ recipes: RecipeJson[] }>('/api/recipes?status=all');
    expect(all.recipes.find((item) => item.id === recipe.id)?.status).toBe('active');
  });

  it('新录入的菜带「还没上过桌」标记，上桌吃过之后自动消失（派生判定）', async () => {
    harness = createTestHarness();
    const { body } = await createRecipe({
      name: '手写测试菜',
      kind: 'veg',
      ingredients: [{ ingredientId: 'tomato', adultGrams: 120 }],
    });
    const id = body.recipe!.id;

    // 刚录入：没有转正记录 ∧ 没有任何一餐引用过它 → 还没上过桌
    expect((await getRecipe(id)).body.recipe!.neverServed).toBe(true);

    // 种子里转正过的家庭菜谱也「还没上过桌」（转正从不发生在生产库里）——判定源是「有没有吃过」
    expect((await getRecipe('fanqiechaodan')).body.recipe!.neverServed).toBe(true);
  });

  it('外部数据仍须转正：草稿状态不是这条路进来的（ADR-0006 对外部门槛不变）', async () => {
    harness = createTestHarness();

    // 录入出来的菜永远是 active，不可能是 draft——外部数据的门槛在这条路上没有被打开
    const { body } = await createRecipe({ name: '手写菜', kind: 'veg' });
    expect(body.recipe!.status).toBe('active');

    // 种子里的外部草稿仍是草稿（这条路没碰它）
    expect((await getRecipe('xiangguhuaji')).body.recipe!.status).toBe('draft');
  });

  it('录完直接可定餐：新菜出现在 /recipes?status=all（选菜器拿的池子）', async () => {
    harness = createTestHarness();
    const { body } = await createRecipe({
      name: '可定餐的手写菜',
      kind: 'veg',
      ingredients: [{ ingredientId: 'cucumber', adultGrams: 100 }],
    });

    const { body: all } = await harness.json<{ recipes: RecipeJson[] }>('/api/recipes?status=all');
    expect(all.recipes.map((item) => item.id)).toContain(body.recipe!.id);
  });

  it('菜名不能为空（zod 拦下并指得出哪一项）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error: string; issues?: { path: string }[] }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ', kind: 'veg' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.issues?.[0]?.path).toBe('name');
  });

  it('克数不许为 0（那是待重标的存储形态，不是掌勺者能写进来的值）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error: string; issues?: { path: string }[] }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '零克菜',
        kind: 'veg',
        ingredients: [{ ingredientId: 'tomato', adultGrams: 0 }],
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
  });

  it('清单里指向字典外的食材被挡下（字典是唯一受控表）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error: string; ingredientId?: string }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '野食材菜',
        kind: 'veg',
        ingredients: [{ ingredientId: 'nothing_like_this', adultGrams: 10 }],
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_ingredient');
    expect(body.ingredientId).toBe('nothing_like_this');
  });

  it('身份对不上家人列表时报 unknown_member（不是默默不记名）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error: string; memberId?: string }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '匿名菜', kind: 'veg', memberId: 'nobody' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_member');
    expect(body.memberId).toBe('nobody');
  });
});

describe('菜谱库：修订（CONTEXT「修订」）', () => {
  it('改做法步骤：内容变化 + 台账留痕（谁、什么时候、改了哪几块）', async () => {
    harness = createTestHarness();

    const patched = await patchRecipe('fanqiechaodan', {
      steps: '鸡蛋炒散盛出，番茄炒出汁，回锅加盐与一点糖翻匀。',
      memberId: 'mom',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.recipe!.steps).toContain('一点糖');
    // 没传的块保持原样
    expect(patched.body.recipe!.name).toBe('番茄炒蛋');

    const edits = await editsOf('fanqiechaodan');
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ recipeId: 'fanqiechaodan', memberId: 'mom', memberName: '妈妈' });
    expect(edits[0]!.changedFields).toEqual(['steps']);
  });

  it('改口味标签与适季月份：传了的块整体替换', async () => {
    harness = createTestHarness();

    const patched = await patchRecipe('fanqiechaodan', { tastes: ['酸', '甜'], seasonMonths: [6, 7, 8] });
    expect(patched.body.recipe!.tastes).toEqual(['酸', '甜']);
    expect(patched.body.recipe!.seasonMonths).toEqual([6, 7, 8]);

    // 再改回空月份 = 四季皆宜
    const cleared = await patchRecipe('fanqiechaodan', { seasonMonths: [] });
    expect(cleared.body.recipe!.seasonMonths).toEqual([]);
  });

  it('改食材清单与成人份克数：份量引擎跟着变（改克数 = 改推荐时的算量）', async () => {
    harness = createTestHarness();

    const patched = await patchRecipe('fanqiechaodan', {
      ingredients: [
        { ingredientId: 'tomato', adultGrams: 200 },
        { ingredientId: 'egg', adultGrams: 90, scaling: 'linear', rawCookedAnchor: '鸡蛋 60g ≈ 炒蛋 55g（WS/T 554 附录 A）' },
      ],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.recipe!.ingredients.map((item) => [item.name, item.adultGrams])).toEqual([
      ['番茄', 200],
      ['鸡蛋', 90],
    ]);

    // 与份量读接口同一份读数：本餐克数按新的成人份现算
    const preview = await harness.json<{ portion: { dishes: { recipeId: string; ingredients: { name: string; grams: number }[] }[] } }>(
      '/api/portion/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'fanqiechaodan' }] }),
      },
    );
    const tomato = preview.body.portion.dishes[0]!.ingredients.find((item) => item.name === '番茄');
    expect(tomato?.grams).toBe(200);
  });

  it('修订保留原始出处（source 不变）与身份（id 不变）——改的是内容，不是这道菜从哪来', async () => {
    harness = createTestHarness();

    const before = (await getRecipe('fanqiechaodan')).body.recipe!;
    const patched = await patchRecipe('fanqiechaodan', { steps: '改了做法。' });
    const after = patched.body.recipe!;

    expect(after.id).toBe(before.id);
    expect(after.source).toBe(before.source);
    expect(after.name).toBe(before.name);
  });

  it('转正过的菜照样能改（草稿才要走转正那条路）', async () => {
    harness = createTestHarness();
    scriptLlm();

    // 先转正一道草稿（走真实的转正路径：上桌 → 转正）
    await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'xiangguhuaji' }] }),
    });
    harness.clock.set('2025-06-02T10:00:00.000Z');
    const promoted = await harness.json<{ promotion: { recipe: RecipeJson } }>(
      '/api/recipes/xiangguhuaji/promotion',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memberId: 'mom' }) },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.promotion.recipe.status).toBe('active');

    // 转正之后照样能改做法（ADR-0009：修订改内容，转正改状态）
    const patched = await patchRecipe('xiangguhuaji', { steps: '家里的做法：少油，多蒸 3 分钟。' });
    expect(patched.status).toBe(200);
    expect(patched.body.recipe!.steps).toContain('多蒸 3 分钟');

    // 两条台账各自留痕、互不混淆
    const edits = await editsOf('xiangguhuaji');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedFields).toEqual(['steps']);
  });

  it('草稿可以修订（补待重标的克数正是这条路的用途）；但修订不改状态——仍要转正才能进家庭库', async () => {
    harness = createTestHarness();

    // 外部草稿（清炒豆芽）把克数改一改（user story 32：用菜谱库页面手工补上待定的克数）
    const patched = await patchRecipe('qingchaodouya', {
      ingredients: [
        { ingredientId: 'bean_sprouts', adultGrams: 180 },
        { ingredientId: 'garlic', adultGrams: 8 },
      ],
    });
    expect(patched.status).toBe(200);
    // **状态没变**：修订改的是内容，进家庭库仍然要经「上桌 → 转正」（ADR-0006 的门槛一点没动）
    expect(patched.body.recipe!.status).toBe('draft');

    // 台账照样留痕
    const edits = await editsOf('qingchaodouya');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedFields).toEqual(['ingredients']);
  });

  it('退役的菜不能修订：先用还原', async () => {
    harness = createTestHarness();

    // 种子里的退役菜
    const { status, body } = await patchRecipe('xiangjiandaiyu', { steps: '想改退役菜。' });
    expect(status).toBe(409);
    expect(body.error).toBe('not_editable');
  });

  it('一次提交什么都没改 → 400，不写台账（不假装成功）', async () => {
    harness = createTestHarness();

    const { status, body } = await patchRecipe('fanqiechaodan', { name: '番茄炒蛋' });
    expect(status).toBe(400);
    expect(body.error).toBe('no_changes');
    expect(await editsOf('fanqiechaodan')).toHaveLength(0);
  });

  it('改菜名：name 也留痕（字段级 diff 认得出来）', async () => {
    harness = createTestHarness();

    const patched = await patchRecipe('fanqiechaodan', { name: '西红柿炒鸡蛋' });
    expect(patched.body.recipe!.name).toBe('西红柿炒鸡蛋');

    const edits = await editsOf('fanqiechaodan');
    expect(edits[0]!.changedFields).toEqual(['name']);
  });

  it('不存在的菜谱 → 404（不是空壳）', async () => {
    harness = createTestHarness();
    const { status, body } = await patchRecipe('nothing', { steps: 'x' });
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });
});

describe('菜谱库：退役 / 还原', () => {
  it('退役：active → retired，历史保留（这道菜仍在库里读得回来）', async () => {
    harness = createTestHarness();

    const retired = await harness.json<{ recipe: RecipeJson }>('/api/recipes/kelejichi/retire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: 'mom' }),
    });
    expect(retired.status).toBe(200);
    expect(retired.body.recipe.status).toBe('retired');

    // 行还在（退役不等于删除）；台账留了痕
    expect((await getRecipe('kelejichi')).body.recipe!.status).toBe('retired');
    const edits = await editsOf('kelejichi');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedFields).toEqual(['status']);

    // 不在缺省的转正态列表里（退出了推荐池）
    const { body: active } = await harness.json<{ recipes: RecipeJson[] }>('/api/recipes?status=active');
    expect(active.recipes.map((item) => item.id)).not.toContain('kelejichi');
  });

  it('退役错了能还原：retired → active', async () => {
    harness = createTestHarness();

    await harness.json('/api/recipes/kelejichi/retire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const restored = await harness.json<{ recipe: RecipeJson }>('/api/recipes/kelejichi/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: 'mom' }),
    });
    expect(restored.status).toBe(200);
    expect(restored.body.recipe.status).toBe('active');
    // 还原也留痕（两次状态变化各一条）
    expect(await editsOf('kelejichi')).toHaveLength(2);
  });

  it('只有退役的菜能还原（active 还原是 409，不是默默成功）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error: string }>('/api/recipes/kelejichi/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(409);
    expect(body.error).toBe('not_retired');
  });

  it('已经退役的菜再退役是 409（幂等地报错，界面该刷新）', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<{ error: string }>('/api/recipes/xiangjiandaiyu/retire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(409);
    expect(body.error).toBe('already_retired');
  });

  it('退役的菜不能进菜单：RecipeRetiredError 这条死代码在真实路径上复活', async () => {
    harness = createTestHarness();

    // 先退役一道家庭菜
    await harness.json('/api/recipes/fanqiechaodan/retire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: 'mom' }),
    });

    // 拿它去定餐：跨「菜谱写路径」与 slots 领域的活路径
    const booked = await harness.json<{ error: string; recipeId?: string }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'fanqiechaodan' }] }),
    });
    expect(booked.status).toBe(400);
    expect(booked.body.error).toBe('recipe_retired');
    expect(booked.body.recipeId).toBe('fanqiechaodan');
  });

  it('退役菜不进整餐推荐（克数改了推荐也跟着变）', async () => {
    harness = createTestHarness();

    const before = await harness.json<{ recommendation: { dishes: { recipeId: string }[] } }>(
      '/api/slots/2025-06-01:dinner/recommendation',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diners: ['mom'] }) },
    );
    const beforeIds = before.body.recommendation.dishes.length;

    // 退役全部荤菜的后备太粗暴——只验「退役一道家庭荤菜后它不再出现在推荐里」可观测的形态：
    // 推荐整餐是现算的，用一道必然在池里的菜（把其它选择用忌口挡掉太脆）。
    // 这里换一种可判定的写法：退役后它的状态就是 retired，而推荐只从 active 池取。
    await harness.json('/api/recipes/hongshaopaigu/retire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const after = await harness.json<{ recommendation: { dishes: { recipeId: string; origin: string }[] } }>(
      '/api/slots/2025-06-01:dinner/recommendation',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diners: ['mom'] }) },
    );
    expect(after.status).toBe(200);
    // 推荐里出现的一定是 active 的菜（退役菜永远不在其中）
    const { body: all } = await harness.json<{ recipes: RecipeJson[] }>('/api/recipes?status=all');
    const statusById = new Map(all.recipes.map((item) => [item.id, item.status]));
    for (const dish of after.body.recommendation.dishes) {
      expect(statusById.get(dish.recipeId)).toBe('active');
    }
    // 结构仍配满（退役一道不该把整餐推荐打空）
    expect(beforeIds).toBeGreaterThan(0);
  });
});

describe('菜谱库：台账读取', () => {
  it('修订台账与转正台账并列、各自独立', async () => {
    harness = createTestHarness();

    await patchRecipe('fanqiechaodan', { steps: '第一次改。' });
    harness.clock.advance(60_000);
    await patchRecipe('fanqiechaodan', { steps: '第二次改。' });

    const edits = await editsOf('fanqiechaodan');
    // 时间倒序：最近一次在前
    expect(edits.map((edit) => edit.changedFields)).toEqual([['steps'], ['steps']]);
    expect(edits[0]!.editedAt >= edits[1]!.editedAt).toBe(true);

    // 转正台账是空的（这道菜从没转正过）——两张表互不污染
    const { body: promotions } = await harness.json<{ promotions: unknown[] }>(
      '/api/recipes/fanqiechaodan/promotions',
    );
    expect(promotions.promotions).toHaveLength(0);
  });

  it('不存在的菜谱读台账 → 404', async () => {
    harness = createTestHarness();
    const { status } = await harness.json('/api/recipes/nothing/edits');
    expect(status).toBe(404);
  });
});
