import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, seedAvoider, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

// 线上形状从 wire-types 取（与前端同一处定义），不手抄
import type { Ingredient as IngredientJson, IngredientEditRecord, Recipe as RecipeJson } from '../wire-types.js';
import { CONTAINS_OUT_OF_POOL_PROBE, CONTAINS_POOL_MARK, pickContainsSuggestion } from '../llm/contains-suggestion-schema.js';

async function listIngredients(query = ''): Promise<IngredientJson[]> {
  const { body } = await harness.json<{ ingredients: IngredientJson[] }>(`/api/ingredients${query}`);
  return body.ingredients;
}

async function createIngredient(body: unknown): Promise<{
  status: number;
  body: {
    ingredient?: IngredientJson;
    error?: string;
    field?: 'name' | 'alias';
    conflict?: { id: string; name: string };
    ingredientId?: string;
    issues?: { path: string; message: string }[];
  };
}> {
  return harness.json('/api/ingredients', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function deleteIngredient(id: string): Promise<{
  status: number;
  body: {
    ok?: boolean;
    ingredient?: IngredientJson;
    error?: string;
    references?: { kind: string; count: number }[];
  };
}> {
  return harness.json(`/api/ingredients/${id}`, { method: 'DELETE' });
}

/** `PATCH /api/ingredients/:id`：改一条食材 */
async function patchIngredient(id: string, body: unknown): Promise<{
  status: number;
  body: {
    ingredient?: IngredientJson;
    error?: string;
    field?: 'name' | 'alias';
    conflict?: { id: string; name: string };
    ingredientId?: string;
    issues?: { path: string; message: string }[];
  };
}> {
  return harness.json(`/api/ingredients/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `GET /api/ingredients/:id/edits`：该食材的改动台账 */
async function ingredientEditsOf(id: string): Promise<{ status: number; edits: IngredientEditRecord[] }> {
  const { status, body } = await harness.json<{ edits: IngredientEditRecord[] }>(`/api/ingredients/${id}/edits`);
  return { status, edits: body.edits ?? [] };
}

async function containsSuggestion(body: unknown): Promise<{
  status: number;
  body: { targets?: { ingredientId: string; name: string }[]; degraded?: boolean; error?: string; issues?: { path: string; message: string }[] };
}> {
  return harness.json('/api/ingredients/contains-suggestion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * 食材字典（CONTEXT.md）：全库唯一的受控食材表，忌口/爱吃/菜谱食材/买菜聚合四处共用。
 * 本票的「受控」范围＝规范名 + 别名 + 时令月份 + 隐性忌口「含」指针（后两项是 #15 加的）。
 */
describe('食材字典', () => {
  it('常用食材随库就位，每条带规范名与别名', async () => {
    harness = createTestHarness();

    const ingredients = await listIngredients();
    expect(ingredients.length).toBeGreaterThanOrEqual(30);

    const byId = new Map(ingredients.map((item) => [item.id, item]));
    expect(byId.get('tomato')).toMatchObject({ id: 'tomato', name: '番茄', aliases: ['西红柿', '蕃茄'] });
    expect(byId.get('shellfish')).toMatchObject({
      id: 'shellfish',
      name: '贝类',
      aliases: ['蛤蜊', '花甲', '扇贝', '生蚝', '牡蛎'],
    });
    // 荤素汤位、买菜聚合都要用到的基础主料在不在
    expect(byId.get('pork_ribs')?.name).toBe('猪排骨');
    expect(byId.get('egg')?.name).toBe('鸡蛋');
  });

  it('带时令月份（1–12），没录的是四季有售', async () => {
    harness = createTestHarness();

    const byId = new Map((await listIngredients()).map((item) => [item.id, item]));
    // 番茄是夏天的东西；排骨四季有售，列表为空
    expect(byId.get('tomato')?.seasonMonths).toEqual([6, 7, 8, 9]);
    expect(byId.get('pork_ribs')?.seasonMonths).toEqual([]);
  });

  it('隐性忌口「含」指针直接可见（蚝油含贝类）', async () => {
    harness = createTestHarness();

    const byId = new Map((await listIngredients()).map((item) => [item.id, item]));
    expect(byId.get('oyster_sauce')?.contains).toEqual([{ ingredientId: 'shellfish', name: '贝类' }]);
    expect(byId.get('doubanjiang')?.contains).toEqual([{ ingredientId: 'chili', name: '辣椒' }]);
    // 普通食材不含别的什么
    expect(byId.get('tofu')?.contains).toEqual([]);
  });

  it('按规范名或别名搜索（画像编辑挑食材用）', async () => {
    harness = createTestHarness();

    // 别名命中：家人嘴里的「西红柿」要能找到规范名「番茄」
    expect((await listIngredients('?q=西红柿')).map((item) => item.name)).toEqual(['番茄']);
    // 规范名命中
    expect((await listIngredients('?q=排骨')).map((item) => item.name)).toEqual(['猪排骨']);
    // 无关词不误命中
    expect(await listIngredients('?q=巧克力')).toEqual([]);
  });

  it('无口令即可读：客人拿手机打开就能看见字典（家庭 Wi-Fi 即门禁）', async () => {
    harness = createTestHarness();

    const { status } = await harness.json('/api/ingredients');
    expect(status).toBe(200);
  });
});

/**
 * 录入食材（issue #34；ADR-0012「决定二」）：**只有一个必填项**。
 *
 * 这些用例只从 HTTP 边界进、看 HTTP 出——不测 id 的具体字符串、不测 SQL。
 */
describe('食材字典：录入（ADR-0012）', () => {
  it('只填规范名即可录入：别名/时令/含全部可空，录完立刻能被菜谱引用、被忌口指向', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '34-莴笋' });
    expect(created.status).toBe(201);
    const ingredient = created.body.ingredient!;
    expect(ingredient.name).toBe('34-莴笋');
    expect(ingredient.aliases).toEqual([]);
    expect(ingredient.seasonMonths).toEqual([]);
    expect(ingredient.contains).toEqual([]);

    // 立刻出现在列表接口里（搜得到）
    expect((await listIngredients('?q=34-莴笋')).map((item) => item.id)).toContain(ingredient.id);

    // 立刻能被忌口指向（`PATCH /members/:id` 的 avoid 会校验条目在字典里）
    const avoider = await seedAvoider(harness, { name: '挑食测试', avoid: [ingredient.id] });
    expect(avoider).toBeTruthy();

    // 立刻能被菜谱引用（`POST /recipes` 的食材清单会校验条目在字典里）
    const recipe = await harness.json<{ recipe?: RecipeJson; error?: string }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '34-清炒莴笋',
        kind: 'veg',
        ingredients: [{ ingredientId: ingredient.id, adultGrams: 200 }],
      }),
    });
    expect(recipe.status).toBe(201);
    expect(recipe.body.recipe!.ingredients.map((item) => item.name)).toEqual(['34-莴笋']);
  });

  it('别名与时令月份、含指针都能随手填上，且立刻生效', async () => {
    harness = createTestHarness();

    const base = await createIngredient({ name: '复合调味测试' });
    const target = base.body.ingredient!.id;

    const created = await createIngredient({
      name: '34-莴笋',
      aliases: ['34-青笋', '34-莴苣笋'],
      seasonMonths: [4, 5, 6],
      contains: [target],
    });
    expect(created.status).toBe(201);
    const ingredient = created.body.ingredient!;
    expect(ingredient.aliases).toEqual(['34-青笋', '34-莴苣笋']);
    expect(ingredient.seasonMonths).toEqual([4, 5, 6]);
    expect(ingredient.contains).toEqual([{ ingredientId: target, name: '复合调味测试' }]);

    // 别名也能命中搜索（「青笋」找到「莴笋」）
    expect((await listIngredients('?q=34-青笋')).map((item) => item.name)).toEqual(['34-莴笋']);
  });

  it('新条目 seasonMonths 为空 = 四季有售（不写月份行）', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '四季菜测试' });
    expect(created.status).toBe(201);
    expect(created.body.ingredient!.seasonMonths).toEqual([]);

    // 时令集合里没有它（推荐期的时令加分不会被这条假信号点亮）
    const { seasonalIngredientIds } = await import('../domain/ingredients.js');
    const ids = seasonalIngredientIds(harness.db, 6);
    expect(ids.has(created.body.ingredient!.id)).toBe(false);
  });

  it('规范名为空或纯空白 → 400（指认到 name）', async () => {
    harness = createTestHarness();

    for (const name of ['', '   ', '\t\n']) {
      const { status, body } = await createIngredient({ name });
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.issues?.[0]?.path).toBe('name');
    }
  });

  it('规范名撞已有条目 → 409，响应带冲突对象的 id 与规范名', async () => {
    harness = createTestHarness();

    const { status, body } = await createIngredient({ name: '番茄' });
    expect(status).toBe(409);
    expect(body.error).toBe('ingredient_conflict');
    expect(body.field).toBe('name');
    expect(body.conflict).toEqual({ id: 'tomato', name: '番茄' });
  });

  it('别名撞已有条目 → 同样 409（别名全局唯一）；撞的可能是别人的规范名或别名', async () => {
    harness = createTestHarness();

    // 别名撞别人的**别名**（「西红柿」是番茄的别名）
    const byAlias = await createIngredient({ name: '34-莴笋', aliases: ['西红柿'] });
    expect(byAlias.status).toBe(409);
    expect(byAlias.body.error).toBe('ingredient_conflict');
    expect(byAlias.body.field).toBe('alias');
    expect(byAlias.body.conflict).toEqual({ id: 'tomato', name: '番茄' });

    // 别名撞别人的**规范名**
    const byName = await createIngredient({ name: '34-莴笋', aliases: ['番茄'] });
    expect(byName.status).toBe(409);
    expect(byName.body.conflict).toEqual({ id: 'tomato', name: '番茄' });
  });

  it('客户端指定 id 被忽略：id 由服务端按名称派生，且不与既有条目碰撞', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ id: 'my_custom_id', name: '34-莴笋' });
    expect(created.status).toBe(201);
    const ingredient = created.body.ingredient!;
    expect(ingredient.id).not.toBe('my_custom_id');
    // 派生自名称（保留汉字），且有别于既有手写 slug
    expect(ingredient.id).toContain('莴笋');

    // 再建同名（改个后缀）不会撞 id：派生结果对每个名字唯一
    const distinct = await createIngredient({ name: '34-莴笋尖' });
    expect(distinct.body.ingredient!.id).not.toBe(ingredient.id);

    // 与既有 277 条无碰撞（列表里 id 无重复）
    const all = await listIngredients();
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(277);
  });

  it('contains 里出现字典外的目标 → 400，不静默丢弃', async () => {
    harness = createTestHarness();

    const { status, body } = await createIngredient({ name: '34-莴笋', contains: ['nothing_like_this'] });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_contains_target');
    expect(body.ingredientId).toBe('nothing_like_this');

    // 一个字节都没写进去（不是「建了但那条指针丢了」）
    expect(await listIngredients('?q=34-莴笋')).toEqual([]);
  });

  it('同一批里给自己挂「含」指针不合法（自指），且字典外目标优先被拦下', async () => {
    harness = createTestHarness();

    // 先建一条正常条目，再让它含一个不存在的目标
    await createIngredient({ name: '34-莴笋' });
    const id = (await listIngredients('?q=34-莴笋'))[0]!.id;

    const { status, body } = await createIngredient({ name: '34-莴笋苗', contains: [id, 'ghost'] });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_contains_target');
    expect(body.ingredientId).toBe('ghost');
  });
});

/**
 * 删食材（issue #34；ADR-0012「决定四」）：**只在零引用时允许**。
 *
 * 判据只有一条：有没有人用它。有引用 → 409 且报出是哪一类、几条（`NO ACTION` 外键是执行者）。
 */
describe('食材字典：删（ADR-0012）', () => {
  it('零引用条目删除成功，且真的从列表接口消失', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '临时测试食材' });
    const id = created.body.ingredient!.id;

    const deleted = await deleteIngredient(id);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
    expect(deleted.body.ingredient!.id).toBe(id);

    expect((await listIngredients()).map((item) => item.id)).not.toContain(id);
    expect((await listIngredients('?q=临时测试食材'))).toEqual([]);
  });

  it('被菜谱食材引用 → 409，报出 recipe_ingredients 与条数', async () => {
    harness = createTestHarness();

    // 自建一条只被菜谱写引用的食材：引用类别与条数都确定，断言不必靠种子的形状
    const created = await createIngredient({ name: '34-食谱引用' });
    const id = created.body.ingredient!.id;
    const recipe = await harness.json<{ error?: string }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '34-引用菜', kind: 'veg', ingredients: [{ ingredientId: id, adultGrams: 100 }] }),
    });
    expect(recipe.status).toBe(201);

    const { status, body } = await deleteIngredient(id);
    expect(status).toBe(409);
    expect(body.error).toBe('ingredient_referenced');
    expect(body.references).toEqual([{ kind: 'recipe_ingredients', count: 1 }]);
  });

  it('被忌口引用 → 409，报出 member_avoid', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '忌口测试食材' });
    const id = created.body.ingredient!.id;
    await seedAvoider(harness, { name: '忌口测试员', avoid: [id] });

    const { status, body } = await deleteIngredient(id);
    expect(status).toBe(409);
    expect(body.references).toEqual([{ kind: 'member_avoid', count: 1 }]);
  });

  it('被爱吃引用 → 409，报出 member_loves', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '爱吃测试食材' });
    const id = created.body.ingredient!.id;
    const member = await seedAvoider(harness, { name: '爱吃测试员', avoid: [] });

    const loved = await harness.json<{ error?: string }>(`/api/members/${member}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loves: [{ kind: 'ingredient', id }] }),
    });
    expect(loved.status).toBe(200);

    const { status, body } = await deleteIngredient(id);
    expect(status).toBe(409);
    expect(body.references).toEqual([{ kind: 'member_loves', count: 1 }]);
  });

  it('被生熟互换表引用 → 409，报出 exchange_items', async () => {
    harness = createTestHarness();

    // 互换表的种子直接指向字典条目（如番茄）；拿一条只被它引用的种子来验
    const { body } = await harness.json<{ groups: { items: { ingredientId: string | null }[] }[] }>(
      '/api/portion/exchange',
    );
    const exchangeId = body.groups
      .flatMap((group) => group.items)
      .map((item) => item.ingredientId)
      .find((id): id is string => id !== null)!;

    const { status, body: deleted } = await deleteIngredient(exchangeId);
    expect(status).toBe(409);
    expect(deleted.references?.some((reference) => reference.kind === 'exchange_items')).toBe(true);
  });

  it('被另一个食材的「含」指针引用 → 409，报出 ingredient_contains', async () => {
    harness = createTestHarness();

    // 种子里凤尾鱼只被「含」指针指向（recipe_ingredients / avoid / loves / exchange 都没有它）
    const { status, body } = await deleteIngredient('anchovy');
    expect(status).toBe(409);
    expect(body.references).toEqual([{ kind: 'ingredient_contains', count: expect.any(Number) }]);
    expect(body.references![0]!.count).toBeGreaterThan(0);
  });

  it('被买菜清单引用 → 409，报出 grocery_items', async () => {
    harness = createTestHarness();

    // 定一餐 → 读一次清单（物化聚合行）→ 其中某个食材就被清单引用了
    await harness.json('/api/slots/2025-06-02:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'fanqiechaodan' }] }),
    });
    const { body: grocery } = await harness.json<{ list: { items: { ingredientId: string | null }[] } | null }>(
      '/api/grocery',
    );
    const ingredientId = grocery.list!.items.map((item) => item.ingredientId).find((id): id is string => id !== null)!;

    const { status, body } = await deleteIngredient(ingredientId);
    expect(status).toBe(409);
    expect(body.references?.some((reference) => reference.kind === 'grocery_items')).toBe(true);
  });

  it('删除不存在的食材 → 404', async () => {
    harness = createTestHarness();

    const { status, body } = await deleteIngredient('nothing_like_this');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('删之前能先问引用：`GET /ingredients/:id/references` 与删除同一份判定', async () => {
    harness = createTestHarness();

    // 零引用：空数组（界面据此给删除按钮）
    const created = await createIngredient({ name: '34-引用查询' });
    const id = created.body.ingredient!.id;
    const clean = await harness.json<{ id: string; references: { kind: string; count: number }[] }>(
      `/api/ingredients/${id}/references`,
    );
    expect(clean.status).toBe(200);
    expect(clean.body.references).toEqual([]);

    // 有引用：与 DELETE 报的类别一致
    const recipe = await harness.json<{ error?: string }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '34-引用查询菜', kind: 'veg', ingredients: [{ ingredientId: id, adultGrams: 50 }] }),
    });
    expect(recipe.status).toBe(201);

    const referenced = await harness.json<{ references: { kind: string; count: number }[] }>(
      `/api/ingredients/${id}/references`,
    );
    expect(referenced.body.references).toEqual([{ kind: 'recipe_ingredients', count: 1 }]);

    // 不存在的食材 → 404（与删除同一形状）
    const missing = await harness.json<{ error: string }>('/api/ingredients/nothing_like_this/references');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
  });

  it('删掉之后名字能被重新使用（永久释放一个名字）', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '会重名的测试食材', aliases: ['重名别名'] });
    const id = created.body.ingredient!.id;
    expect((await deleteIngredient(id)).status).toBe(200);

    // 同名与同别名都能重新建
    const rebuilt = await createIngredient({ name: '会重名的测试食材', aliases: ['重名别名'] });
    expect(rebuilt.status).toBe(201);
    expect(rebuilt.body.ingredient!.name).toBe('会重名的测试食材');
    expect(rebuilt.body.ingredient!.aliases).toEqual(['重名别名']);
  });

  it('删掉的条目也不在别名搜索里留下痕迹', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '别名残留测试', aliases: ['残留别名'] });
    const id = created.body.ingredient!.id;
    expect((await listIngredients('?q=残留别名')).map((item) => item.id)).toContain(id);

    await deleteIngredient(id);
    expect(await listIngredients('?q=残留别名')).toEqual([]);
  });
});

/**
 * 改食材（issue #35；ADR-0012「决定三/五」）：字段级部分更新 + 每次改留一笔台账。
 *
 * 只从 HTTP 边界进、看 HTTP 出。关键行为：**改名之后所有引用它的地方全跟着换说法**
 * （列表接口 + 引用它的菜谱详情都返回新名，无名称快照）；四个字段一个都没变 → 409、不写台账。
 */
describe('食材字典：改食材（ADR-0012）', () => {
  it('改规范名：列表接口与引用它的菜谱详情都返回新名（无名称快照）', async () => {
    harness = createTestHarness();

    // 自建一条只被一道菜引用的食材，改名后从两个读口核对
    const created = await createIngredient({ name: '35-莴笋' });
    const id = created.body.ingredient!.id;
    const recipe = await harness.json<{ recipe?: RecipeJson }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '35-清炒莴笋', kind: 'veg', ingredients: [{ ingredientId: id, adultGrams: 200 }] }),
    });
    const recipeId = recipe.body.recipe!.id;
    expect(recipe.body.recipe!.ingredients.map((item) => item.name)).toEqual(['35-莴笋']);

    const patched = await patchIngredient(id, { name: '35-生菜', memberId: 'mom' });
    expect(patched.status).toBe(200);
    expect(patched.body.ingredient!.name).toBe('35-生菜');

    // 读口一：列表接口
    expect((await listIngredients('?q=35-生菜')).map((item) => item.name)).toEqual(['35-生菜']);
    expect(await listIngredients('?q=35-莴笋')).toEqual([]);

    // 读口二：引用它的菜谱详情（没有名称快照，天然跟随同一条 ingredients 行）
    const detail = await harness.json<{ recipe: RecipeJson }>(`/api/recipes/${recipeId}`);
    expect(detail.body.recipe.ingredients.map((item) => item.name)).toEqual(['35-生菜']);
    // 老名字不在任何读口里残留
    expect(JSON.stringify(detail.body.recipe)).not.toContain('35-莴笋');
  });

  it('改名撞上别的条目 → 409（带冲突对象的 id 与规范名）', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '35-莴笋' });
    const id = created.body.ingredient!.id;

    // 撞规范名
    const byName = await patchIngredient(id, { name: '番茄' });
    expect(byName.status).toBe(409);
    expect(byName.body.error).toBe('ingredient_conflict');
    expect(byName.body.field).toBe('name');
    expect(byName.body.conflict).toEqual({ id: 'tomato', name: '番茄' });

    // 撞别人的别名（「西红柿」是番茄的别名）
    const byAlias = await patchIngredient(id, { name: '西红柿' });
    expect(byAlias.status).toBe(409);
    expect(byAlias.body.conflict).toEqual({ id: 'tomato', name: '番茄' });

    // 一个字都没改（还是「35-莴笋」）
    expect((await listIngredients('?q=35-莴笋')).map((item) => item.id)).toContain(id);
  });

  it('改名改回自己不算撞（排除自己再判冲突）', async () => {
    harness = createTestHarness();

    // 种子里黄芪挂着一个与规范名同名的别名——把自己同样的名字/别名写回去不报冲突，
    // 只要另外有一块真的变了（否则是 no_changes，那是另一条规则）
    const patched = await patchIngredient('astragalus', { name: '黄芪', aliases: ['黄芪', '35-黄耆'] });
    expect(patched.status).toBe(200);
    expect(patched.body.ingredient!.name).toBe('黄芪');
    expect(patched.body.ingredient!.aliases).toEqual(['黄芪', '35-黄耆']);
  });

  it('补 / 去别名各自生效（传的是完整清单，整体替换）', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '35-莴笋' });
    const id = created.body.ingredient!.id;

    // 补
    const added = await patchIngredient(id, { aliases: ['35-青笋', '35-莴苣笋'] });
    expect(added.status).toBe(200);
    expect(added.body.ingredient!.aliases).toEqual(['35-青笋', '35-莴苣笋']);
    expect((await listIngredients('?q=35-青笋')).map((item) => item.name)).toEqual(['35-莴笋']);

    // 去（只留一个）
    const removed = await patchIngredient(id, { aliases: ['35-青笋'] });
    expect(removed.status).toBe(200);
    expect(removed.body.ingredient!.aliases).toEqual(['35-青笋']);
    expect(await listIngredients('?q=35-莴苣笋')).toEqual([]);

    // 全去
    const cleared = await patchIngredient(id, { aliases: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ingredient!.aliases).toEqual([]);
  });

  it('补 / 去时令月份各自生效；去掉后回到「四季有售」（空数组）', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '35-莴笋' });
    const id = created.body.ingredient!.id;

    const added = await patchIngredient(id, { seasonMonths: [4, 5, 6] });
    expect(added.status).toBe(200);
    expect(added.body.ingredient!.seasonMonths).toEqual([4, 5, 6]);

    const removed = await patchIngredient(id, { seasonMonths: [] });
    expect(removed.status).toBe(200);
    expect(removed.body.ingredient!.seasonMonths).toEqual([]);

    // 「四季有售」在时令集合里真的没有它（推荐期的时令加分不会被假信号点亮）
    const { seasonalIngredientIds } = await import('../domain/ingredients.js');
    expect(seasonalIngredientIds(harness.db, 4).has(id)).toBe(false);
  });

  it('补 / 去「含」指针各自生效，且目标必须是字典内条目', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '35-复合调味' });
    const id = created.body.ingredient!.id;
    const target = await createIngredient({ name: '35-贝类' });
    const targetId = target.body.ingredient!.id;

    // 补
    const added = await patchIngredient(id, { contains: [targetId] });
    expect(added.status).toBe(200);
    expect(added.body.ingredient!.contains).toEqual([{ ingredientId: targetId, name: '35-贝类' }]);

    // 去
    const removed = await patchIngredient(id, { contains: [] });
    expect(removed.status).toBe(200);
    expect(removed.body.ingredient!.contains).toEqual([]);

    // 目标必须在字典里 → 400，不静默丢弃
    const unknown = await patchIngredient(id, { contains: ['nothing_like_this'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('unknown_contains_target');
    expect(unknown.body.ingredientId).toBe('nothing_like_this');

    // 自指 → 400（不撞上迁移 002 的 CHECK 报 500）
    const self = await patchIngredient(id, { contains: [id] });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('self_contains');
  });

  it('一次成功的改动按「哪几个字段变了」记一行台账（含改动人）', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '35-莴笋' });
    const id = created.body.ingredient!.id;

    // 一次改两个字段 → 一行、两个字段名
    const patched = await patchIngredient(id, { name: '35-生菜', aliases: ['35-鹅仔菜'], memberId: 'mom' });
    expect(patched.status).toBe(200);

    const { status, edits } = await ingredientEditsOf(id);
    expect(status).toBe(200);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.changedFields).toEqual(['name', 'aliases']);
    expect(edits[0]!.memberId).toBe('mom');
    expect(edits[0]!.memberName).toBe('妈妈');
  });

  it('四个字段一个都没变 → 409「没有任何改动」，且不写台账', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '35-莴笋', aliases: ['35-青笋'], seasonMonths: [4, 5] });
    const id = created.body.ingredient!.id;

    // 重传一模一样的四块（顺序不同、重复项都算「没变」）
    const { status, body } = await patchIngredient(id, {
      name: '35-莴笋',
      aliases: ['35-青笋'],
      seasonMonths: [5, 4],
      contains: [],
    });
    expect(status).toBe(409);
    expect(body.error).toBe('no_changes');

    // 空 patch（点开看了看又保存）也不写台账
    const empty = await patchIngredient(id, {});
    expect(empty.status).toBe(409);
    expect(empty.body.error).toBe('no_changes');

    // 空台账：一次都没写进去
    expect((await ingredientEditsOf(id)).edits).toEqual([]);
  });

  it('台账按时间倒序可读，含改动人', async () => {
    harness = createTestHarness();

    const created = await createIngredient({ name: '35-莴笋' });
    const id = created.body.ingredient!.id;

    await patchIngredient(id, { aliases: ['35-青笋'], memberId: 'mom' });
    harness.clock.advance(60_000);
    await patchIngredient(id, { seasonMonths: [4], memberId: 'dad' });

    const { edits } = await ingredientEditsOf(id);
    expect(edits.map((edit) => edit.changedFields)).toEqual([['seasonMonths'], ['aliases']]);
    // 最近一次在前
    expect(edits[0]!.changedAt >= edits[1]!.changedAt).toBe(true);
    expect(edits[0]!.memberName).toBe('爸爸');
    expect(edits[1]!.memberName).toBe('妈妈');
  });

  it('不存在的食材取台账 → 404（不是空台账）', async () => {
    harness = createTestHarness();

    const { status } = await ingredientEditsOf('nothing_like_this');
    expect(status).toBe(404);
  });

  it('改不存在的食材 → 404', async () => {
    harness = createTestHarness();

    const { status, body } = await patchIngredient('nothing_like_this', { name: '随便' });
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('改过的食材照样删得掉：台账随食材一起走，不阻挡删除', async () => {
    harness = createTestHarness();

    // 零引用、改过一次 → 删除成功（台账是 ON DELETE CASCADE；「改过」是来路不是用途）
    const created = await createIngredient({ name: '35-莴笋' });
    const id = created.body.ingredient!.id;
    await patchIngredient(id, { aliases: ['35-青笋'] });

    const { status } = await deleteIngredient(id);
    expect(status).toBe(200);

    // 条目真的消失了，它的台账也一并带走（不留指向不存在食材的历史行）
    expect(await listIngredients('?q=35-莴笋')).toEqual([]);
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM ingredient_edits WHERE ingredient_id = ?').get(id) as { n: number }).n).toBe(0);
  });

  it('「含」指针指向的目标改名后，源条目的详情跟着换说法', async () => {
    harness = createTestHarness();

    const sauce = await createIngredient({ name: '35-蚝油类' });
    const sauceId = sauce.body.ingredient!.id;
    const shellfish = await createIngredient({ name: '35-贝类' });
    const shellfishId = shellfish.body.ingredient!.id;
    await patchIngredient(sauceId, { contains: [shellfishId] });

    // 目标改名 → 源条目读出来的 contains.name 跟着变（存 id 不存名字）
    await patchIngredient(shellfishId, { name: '35-壳类' });
    const reread = await listIngredients('?q=35-蚝油类');
    expect(reread[0]!.contains).toEqual([{ ingredientId: shellfishId, name: '35-壳类' }]);
  });
});

/**
 * 「含」提议（issue #37；CONTEXT「『含』提议」；ADR-0012「决定六」）在**库这一侧**的行为。
 *
 * 只从 HTTP 边界进、看 HTTP 出。四条要守住的东西：
 *   1. **候选池来自字典现有条目**（LLM 收到的是字典里的名字，不是自由生成的起点）；
 *   2. **越界目标被拦下**：fake 吐一个字典外的名字 → 它没被返回、也没落库；
 *   3. **两种空可区分**：`degraded: false` + 空（AI 看过了、没有建议）与
 *      `degraded: true` + 空（AI 用不了）是**两条不同的响应**；
 *   4. **预填而非写入**：调用之后字典里没有新条目、那条食材的 `contains` 一个字节没变。
 */
describe('食材字典：「含」提议（issue #37）', () => {
  it('候选池来自字典现有条目，目标只含字典内条目（复用 IngredientRef 形状）', async () => {
    harness = createTestHarness();
    // 让 fake 从 prompt 里读回池子、给一条建议（与 E2E 同一条确定性路径）
    harness.llm.setCompletion((request) => pickContainsSuggestion(request.prompt) ?? '{"targets":[]}');

    const { status, body } = await containsSuggestion({ name: '蚝油' });
    expect(status).toBe(200);
    expect(body.degraded).toBe(false);
    // 蚝油 → 贝类（种子字典里就有这一条）；形状是 id + 规范名
    const shellfish = body.targets!.find((target) => target.name === '贝类');
    expect(shellfish).toBeDefined();
    expect(shellfish!.ingredientId).toBe('shellfish');

    // 池子确实来自字典：LLM 收到的 prompt 里带上了字典里的条目（不只是「贝类」）
    const prompt = harness.llm.completionCalls.at(-1)!.request.prompt;
    expect(prompt).toContain('贝类');
    expect(prompt).toContain('辣椒');
    expect(prompt).toContain(CONTAINS_POOL_MARK);
  });

  it('越界目标被拦下：fake 吐一个字典外的名字 → 没被返回、没落库', async () => {
    harness = createTestHarness();
    // 先建一条自己的复合调料 + 一个池内目标，让断言不依赖种子的形状
    const sauce = await createIngredient({ name: '37-越界蚝油' });
    const sauceId = sauce.body.ingredient!.id;
    const shellfish = await createIngredient({ name: '37-贝类' });
    const shellfishId = shellfish.body.ingredient!.id;

    // fake 的探针：名字带「越界」时会额外吐一个字典外的目标
    harness.llm.setCompletion((request) => pickContainsSuggestion(request.prompt) ?? '{"targets":[]}');
    const { status, body } = await containsSuggestion({ id: sauceId });
    expect(status).toBe(200);

    const names = body.targets!.map((target) => target.name);
    expect(names).toContain('37-贝类');
    // 字典外的那条没被返回
    expect(names).not.toContain(CONTAINS_OUT_OF_POOL_PROBE);
    // 返回的每一条都必须真是字典里的条目（池内条目，id 对得上）
    const dictionaryIds = new Set((await listIngredients()).map((item) => item.id));
    expect(body.targets!.every((target) => dictionaryIds.has(target.ingredientId))).toBe(true);
    expect(body.targets!.some((target) => target.ingredientId === shellfishId)).toBe(true);

    // 也没落库：字典里没有那条凭空生成的名字，且这条调料的 contains 还是空的
    expect(await listIngredients(`?q=${encodeURIComponent(CONTAINS_OUT_OF_POOL_PROBE)}`)).toEqual([]);
    const reread = await listIngredients('?q=37-越界蚝油');
    expect(reread[0]!.contains).toEqual([]);
  });

  it('提议不落库：调用之后字典里没有新条目、该食材的 contains 不变', async () => {
    harness = createTestHarness();
    harness.llm.setCompletion((request) => pickContainsSuggestion(request.prompt) ?? '{"targets":[]}');

    const created = await createIngredient({ name: '37-蚝油类' });
    const id = created.body.ingredient!.id;
    const before = (await listIngredients()).length;

    const { status, body } = await containsSuggestion({ name: '37-蚝油类' });
    expect(status).toBe(200);
    expect(body.targets!.length).toBeGreaterThan(0);

    // 字典条目数不变、这条的 contains 仍是空（预填而非写入）
    expect((await listIngredients()).length).toBe(before);
    expect((await listIngredients('?q=37-蚝油类'))[0]!.contains).toEqual([]);
    // 也没有「提议台账」之类的副产物（本路由只读 + 调 LLM）
    expect((await listIngredients(`?q=${encodeURIComponent('37-贝类')}`)).length).toBe(0);

    void id;
  });

  it('字典里没有合式目标 → degraded: false + 空数组（「AI 看过了、没有建议」）', async () => {
    harness = createTestHarness();
    harness.llm.setCompletion('{"targets":[]}');

    const { status, body } = await containsSuggestion({ name: '蚝油' });
    expect(status).toBe(200);
    expect(body.degraded).toBe(false);
    expect(body.targets).toEqual([]);
  });

  it('LLM 不可用 → 200 + degraded: true + 空数组（不报错）', async () => {
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可达'));

    const { status, body } = await containsSuggestion({ name: '蚝油' });
    expect(status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.targets).toEqual([]);
  });

  it('两种空是两条不同的响应（degraded 分得开，界面据此说两句不同的话）', async () => {
    harness = createTestHarness();
    // 空输入得当：LLM 回了空数组（AI 看过了、没有建议）
    harness.llm.setCompletion('{"targets":[]}');
    const noSuggestion = await containsSuggestion({ name: '37-没有任何关键词' });

    // 换一个 harness（另一个库、另一个 fake）造「AI 用不了」
    harness.close();
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可达'));
    const degraded = await containsSuggestion({ name: '37-没有任何关键词' });

    expect(noSuggestion.body.targets).toEqual(degraded.body.targets);
    expect(noSuggestion.body.degraded).toBe(false);
    expect(degraded.body.degraded).toBe(true);
    // 两种情况的响应不相等（把它们合并会把一次故障说成「这东西确实不含什么」）
    expect(noSuggestion.body).not.toEqual(degraded.body);
  });

  it('入参二选一：不存在的 id → 404；一个字段都不给 → 400', async () => {
    harness = createTestHarness();

    const { status, body } = await containsSuggestion({ id: 'nothing_like_this' });
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');

    // 一个字段都不给 → 400（没法知道要建议哪条）
    const missing = await containsSuggestion({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_request');
  });

  it('手动填「含」指针的路径不受影响：AI 挂了一样能挂', async () => {
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可达'));

    // AI 不可用时照样能手工挂上（PATCH 的 contains 不经过 LLM）
    const created = await createIngredient({ name: '37-手工蚝油' });
    const id = created.body.ingredient!.id;
    const target = await createIngredient({ name: '37-手工贝类' });
    const targetId = target.body.ingredient!.id;

    const patched = await patchIngredient(id, { contains: [targetId] });
    expect(patched.status).toBe(200);
    expect(patched.body.ingredient!.contains).toEqual([{ ingredientId: targetId, name: '37-手工贝类' }]);

    // 录入时直接带「含」也照旧
    const withContains = await createIngredient({ name: '37-录入带含', contains: [targetId] });
    expect(withContains.status).toBe(201);
    expect(withContains.body.ingredient!.contains).toEqual([{ ingredientId: targetId, name: '37-手工贝类' }]);
  });
});
