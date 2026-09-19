import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

// 线上形状从 wire-types 取（与前端同一处定义），不手抄
import type { Ingredient as IngredientJson } from '../wire-types.js';

async function listIngredients(query = ''): Promise<IngredientJson[]> {
  const { body } = await harness.json<{ ingredients: IngredientJson[] }>(`/api/ingredients${query}`);
  return body.ingredients;
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
