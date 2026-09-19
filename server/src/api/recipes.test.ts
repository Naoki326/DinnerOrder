import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

// 线上形状从 wire-types 取（与前端同一处定义），不手抄
import type { Recipe as RecipeJson } from '../wire-types.js';

async function listRecipes(status = ''): Promise<RecipeJson[]> {
  const { body } = await harness.json<{ recipes: RecipeJson[] }>(`/api/recipes${status}`);
  return body.recipes;
}

async function getRecipe(id: string): Promise<RecipeJson> {
  const { status, body } = await harness.json<{ recipe: RecipeJson }>(`/api/recipes/${id}`);
  expect(status).toBe(200);
  return body.recipe;
}

/**
 * 菜谱库（总纲 §2.8 精简核心集）：菜名 + 别名、荤素汤（汤分荤素）、每项食材成人份生重基准 +
 * 可缩放规则 + 生熟换算锚点、口味封闭五标签、适季月份、忌口推导、难度三档、状态机、来源。
 */
describe('菜谱库', () => {
  it('家里常做的菜以转正态随库就位（推荐池的唯一来源）', async () => {
    harness = createTestHarness();

    const recipes = await listRecipes();
    expect(recipes.length).toBeGreaterThanOrEqual(15);
    expect(recipes.every((recipe) => recipe.status === 'active')).toBe(true);

    // 原型 RECIPES 里的荤素汤位齐备：荤 / 素 / 汤（汤分荤素）
    const kinds = new Set(recipes.map((recipe) => recipe.kind));
    expect(kinds).toEqual(new Set(['meat', 'veg', 'soup_meat', 'soup_veg']));

    // 每道菜都有成人份基准（份量引擎按它折算，#16）
    for (const recipe of recipes) {
      expect(recipe.ingredients.length, recipe.name).toBeGreaterThan(0);
      expect(recipe.ingredients.every((item) => item.adultGrams > 0), recipe.name).toBe(true);
    }
  });

  it('草稿与退役不进缺省的转正态列表，要看得显式查（草稿→转正→退役）', async () => {
    harness = createTestHarness();

    const active = await listRecipes();
    expect(active.map((recipe) => recipe.id)).not.toContain('xiangguhuaji');
    expect(active.map((recipe) => recipe.id)).not.toContain('xiangjiandaiyu');

    const drafts = await listRecipes('?status=draft');
    expect(drafts.map((recipe) => recipe.id)).toEqual(['xiangguhuaji']);
    expect(drafts[0]?.source).toBe('howtocook');

    const retired = await listRecipes('?status=retired');
    expect(retired.map((recipe) => recipe.id)).toEqual(['xiangjiandaiyu']);
    expect(retired[0]?.source).toBe('scraped');
  });

  it('菜谱带别名、口味封闭五标签、适季月份、难度与来源', async () => {
    harness = createTestHarness();

    const fish = await getRecipe('qingzhengluyu');
    expect(fish).toMatchObject({
      name: '清蒸鲈鱼',
      kind: 'meat',
      effort: 'medium',
      status: 'active',
      source: 'oral',
    });
    expect(fish.tastes).toEqual(['清淡', '咸鲜']);
    // 家人叫法：爸爸嘴里的「清蒸鱼」要能对上「清蒸鲈鱼」
    expect(fish.aliases).toContain('清蒸鱼');
    // 鲈鱼四季有售 → 没录适季月份（空 = 四季皆宜）
    expect(fish.seasonMonths).toEqual([]);

    // 白灼虾是夏天的菜，也是口味的另一种组合
    const shrimp = await getRecipe('baizhuoxia');
    expect(shrimp.seasonMonths).toEqual([5, 6, 7, 8, 9, 10]);
    expect(shrimp.tastes).toEqual(['清淡']);
  });

  it('每项食材带成人份生重基准与可缩放规则（fixed 不随人数放大）', async () => {
    harness = createTestHarness();

    const stew = await getRecipe('tudouniuniu');
    expect(stew.ingredients).toEqual([
      {
        ingredientId: 'beef_brisket',
        name: '牛腩',
        adultGrams: 110,
        scaling: 'linear',
        rawCookedAnchor: null,
      },
      { ingredientId: 'potato', name: '土豆', adultGrams: 110, scaling: 'linear', rawCookedAnchor: null },
    ]);

    // 虫草花一锅就放 5g：人多也不是 10g —— fixed 的意义（#16 份量引擎按它区分）
    const chicken = await getRecipe('chongcaohuazhengji');
    const flower = chicken.ingredients.find((item) => item.ingredientId === 'cordyceps_flower');
    expect(flower).toMatchObject({ adultGrams: 5, scaling: 'fixed' });
    expect(chicken.ingredients.find((item) => item.ingredientId === 'chicken_legs')).toMatchObject({
      adultGrams: 140,
      scaling: 'linear',
    });
  });

  it('生熟换算锚点随菜谱食材存着（WS/T 554 互换表；大米生重 → 米饭）', async () => {
    harness = createTestHarness();

    const rice = await getRecipe('danchaofan');
    const item = rice.ingredients.find((ingredient) => ingredient.ingredientId === 'rice');
    expect(item?.adultGrams).toBe(100);
    expect(item?.rawCookedAnchor).toContain('米饭 220g');
  });

  it('忌口关联由食材清单 ∪ 隐性忌口「含」指针推出（蚝油 → 贝类、豆瓣酱 → 辣椒）', async () => {
    harness = createTestHarness();

    // 蚝油生菜：食材清单里没有贝类，但蚝油含贝类 —— 小宝忌贝类要吃不到这道菜
    const lettuce = await getRecipe('haoyoushengcai');
    expect(lettuce.avoidIngredientIds).toContain('shellfish');
    expect(lettuce.avoidIngredientIds).not.toContain('shrimp');
    expect(lettuce.avoidIngredientIds).toEqual(expect.arrayContaining(['lettuce', 'oyster_sauce']));

    // 麻婆豆腐：豆瓣酱含辣椒 —— 大宝忌辣
    const mapo = await getRecipe('mapodoufu');
    expect(mapo.avoidIngredientIds).toContain('chili');
    expect(mapo.avoidIngredientIds).toEqual(expect.arrayContaining(['tofu', 'pork_mince', 'doubanjiang']));

    // 没有隐性指针的菜：清单就是清单
    expect((await getRecipe('baizhuoxia')).avoidIngredientIds).toEqual(['shrimp']);
  });

  it('口味标签与原型一致：黄焖鸡带「辣」（原型的 spicy:true），不丢标签', async () => {
    harness = createTestHarness();

    // 黄焖鸡在原型里标了 spicy:true；漏了它，靠「辣」做的口味过滤/展示就会失真
    expect((await getRecipe('huangmenji')).tastes).toContain('辣');
    expect((await getRecipe('mapodoufu')).tastes).toContain('辣');
    // 封闭五标签之外的值进不来（字典序也只是参考，这里只验集合包含）
    const allowed = new Set(['甜', '辣', '酸', '咸鲜', '清淡']);
    for (const id of ['huangmenji', 'mapodoufu', 'tangculiji', 'qingzhengluyu']) {
      const recipe = await getRecipe(id);
      expect(recipe.tastes.every((taste) => allowed.has(taste)), `${id} 的口味标签`).toBe(true);
    }
  });

  it('做法步骤是自由文本，给掌勺者参考（不进推荐管线）', async () => {
    harness = createTestHarness();

    expect((await getRecipe('fanqiechaodan')).steps).toContain('番茄');
    expect((await getRecipe('fanqiechaodan')).steps.length).toBeGreaterThan(10);
  });

  it('不存在的菜谱返回 404（不是空壳）', async () => {
    harness = createTestHarness();

    const { status, body } = await harness.json<{ error: string }>('/api/recipes/nothing');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('非法 status 被 zod 拦下（错误体指得出哪一项）', async () => {
    harness = createTestHarness();

    const { status, body } = await harness.json<{ error: string; issues?: { path: string }[] }>(
      '/api/recipes?status=deleted',
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.issues?.[0]?.path).toBe('status');
  });
});
