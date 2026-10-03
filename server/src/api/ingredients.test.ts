import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, seedAvoider, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

// 线上形状从 wire-types 取（与前端同一处定义），不手抄
import type { Ingredient as IngredientJson, Recipe as RecipeJson } from '../wire-types.js';

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
