import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import type {
  DinerPortion,
  DishIngredientPortion,
  DishPortion,
  ExchangeGroup,
  ExchangeConversionResponse,
  MenuPortion,
  PortionPreviewResponse,
  PortionRules,
  PortionRulesResponse,
  ExchangeTableResponse,
  SlotResponse,
  SlotsResponse,
} from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 份量引擎（总纲 §3 决议 2、§5；ADR-0004）：纯规则查表，LLM 不进数值路径。
 *
 * 本文件只在 API seam 上断言**外部可见行为**：分带系数、逐食材克数、年龄现算、
 * 组合名单、互换换算。规则表的入库值经 `GET /api/portion/rules` 读出后断言语义，
 * 不直接查表结构（表怎么存是迁移的自由，只要能推出这些数）。
 */

async function preview(diners: string[], dishes: { recipeId: string; keepLeftover?: boolean }[]) {
  return await harness.json<
    PortionPreviewResponse & {
      error?: string;
      recipeId?: string;
      memberId?: string;
      issues?: { path: string; message: string }[];
    }
  >('/api/portion/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ diners, dishes }),
  });
}

async function portionOf(diners: string[], dishes: { recipeId: string; keepLeftover?: boolean }[]): Promise<MenuPortion> {
  const { status, body } = await preview(diners, dishes);
  expect(status).toBe(200);
  return body.portion;
}

function dinerOf(portion: MenuPortion, memberId: string): DinerPortion {
  const diner = portion.diners.find((item) => item.memberId === memberId);
  if (!diner) throw new Error(`没有这个用餐者：${memberId}`);
  return diner;
}

function dishOf(portion: MenuPortion, recipeId: string): DishPortion {
  const dish = portion.dishes.find((item) => item.recipeId === recipeId);
  if (!dish) throw new Error(`没有这道菜：${recipeId}`);
  return dish;
}

function ingredientOf(dish: DishPortion, ingredientId: string): DishIngredientPortion {
  const item = dish.ingredients.find((entry) => entry.ingredientId === ingredientId);
  if (!item) throw new Error(`这道菜里没有这个食材：${ingredientId}`);
  return item;
}

/**
 * 份量与用餐者名单（总纲 §2.9、§3 决议 2）：
 * 份量 = 菜谱成人份生重基准 × Σ用餐者折算系数 × 留量上浮（本票恒 1）。
 */
describe('份量折算', () => {
  it('两个成人：成人份基准 × 2，折算系数恒 1（大人不折算）', async () => {
    harness = createTestHarness();

    const portion = await portionOf(['mom', 'dad'], [{ recipeId: 'hongshaopaigu' }]);
    expect(portion.asOf).toBe('2025-06-01');
    expect(portion.uplift).toBe(1);
    expect(portion.factorSum).toBeCloseTo(2, 6);

    expect(portion.diners.map((diner) => [diner.name, diner.ageYears, diner.factor])).toEqual([
      ['妈妈', null, 1],
      ['爸爸', null, 1],
    ]);
    expect(portion.diners.every((diner) => diner.kind === 'adult' && diner.bandId === 'adult')).toBe(true);

    const dish = dishOf(portion, 'hongshaopaigu');
    expect(dish.name).toBe('红烧排骨');
    expect(dish.kind).toBe('meat');
    const ribs = ingredientOf(dish, 'pork_ribs');
    expect(ribs.adultGrams).toBe(150);
    expect(ribs.scaling).toBe('linear');
    expect(ribs.grams).toBe(300);
    expect(dish.totalGrams).toBe(300);
  });

  it('组合名单（两大两小）：两份大人的 1 加小孩的分带系数，逐项取整', async () => {
    harness = createTestHarness();

    // 注入时钟 2025-06-01：大宝（2017-05）8 岁 → 6–8 男 0.756；小宝（2021-09）3 岁 → 2–3 档 0.408
    const portion = await portionOf(['mom', 'dad', 'dabao', 'xiaobao'], [{ recipeId: 'hongshaopaigu' }]);
    expect(portion.factorSum).toBeCloseTo(3.164, 6);
    expect(dinerOf(portion, 'dabao')).toMatchObject({ ageYears: 8, bandId: 'child_6_8_male', factor: 0.756 });
    expect(dinerOf(portion, 'xiaobao')).toMatchObject({ ageYears: 3, bandId: 'preschool_2_3', factor: 0.408 });

    // 150 × 3.164 = 474.6 → 475（(单人份 + 小孩系数) 合计后再取整，不是逐人取整再相加）
    expect(ingredientOf(dishOf(portion, 'hongshaopaigu'), 'pork_ribs').grams).toBe(475);
  });

  it('固定量食材不随人数放大（一锅就放这么多），线性食材才乘系数', async () => {
    harness = createTestHarness();

    const portion = await portionOf(['mom', 'dad'], [{ recipeId: 'kelejichi' }]);
    const dish = dishOf(portion, 'kelejichi');
    expect(ingredientOf(dish, 'chicken_wings')).toMatchObject({ adultGrams: 130, scaling: 'linear', grams: 260 });
    expect(ingredientOf(dish, 'cooking_oil')).toMatchObject({ adultGrams: 10, scaling: 'fixed', grams: 10 });
    expect(dish.totalGrams).toBe(270);
  });

  it('单小孩：系数乘积后逐项取整，合计是取整后之和', async () => {
    harness = createTestHarness();

    // 冬瓜排骨汤：排骨 60 × 0.408 = 24.48 → 24；冬瓜 110 × 0.408 = 44.88 → 45
    const portion = await portionOf(['xiaobao'], [{ recipeId: 'dongguapaigutang' }]);
    const dish = dishOf(portion, 'dongguapaigutang');
    expect(ingredientOf(dish, 'pork_ribs').grams).toBe(24);
    expect(ingredientOf(dish, 'winter_melon').grams).toBe(45);
    expect(dish.totalGrams).toBe(69);
  });

  it('同一份名单连名字重复也只算一次（用餐者名单是集合）', async () => {
    harness = createTestHarness();

    const portion = await portionOf(['mom', 'mom', 'dad'], [{ recipeId: 'hongshaopaigu' }]);
    expect(portion.factorSum).toBeCloseTo(2, 6);
    expect(portion.diners.map((diner) => diner.memberId)).toEqual(['mom', 'dad']);
    expect(ingredientOf(dishOf(portion, 'hongshaopaigu'), 'pork_ribs').grams).toBe(300);
  });

  it('多道菜各自算各自的份量，顺序按请求给的来', async () => {
    harness = createTestHarness();

    const portion = await portionOf(
      ['mom'],
      [{ recipeId: 'fanqiechaodan' }, { recipeId: 'dongguapaigutang' }],
    );
    expect(portion.dishes.map((dish) => dish.recipeId)).toEqual(['fanqiechaodan', 'dongguapaigutang']);
    expect(ingredientOf(dishOf(portion, 'fanqiechaodan'), 'tomato').grams).toBe(120);
    expect(portion.factorSum).toBeCloseTo(1, 6);
  });

  it('退役的菜也能算份量（历史菜单里可能有退役前的菜，份量不能被它挡住）', async () => {
    harness = createTestHarness();

    const portion = await portionOf(['mom'], [{ recipeId: 'xiangjiandaiyu' }]);
    expect(dishOf(portion, 'xiangjiandaiyu').name).toBe('香煎带鱼');
    expect(ingredientOf(dishOf(portion, 'xiangjiandaiyu'), 'hairtail').grams).toBe(150);
  });

  it('份量全程不碰 LLM（ADR-0004：LLM 不进数值路径）', async () => {
    harness = createTestHarness();

    await portionOf(['mom', 'dabao'], [{ recipeId: 'hongshaopaigu' }]);
    await harness.json('/api/portion/rules');
    expect(harness.llm.calls).toEqual([]);
  });

  it('库里存量脏数据（空名单的旧菜单）经读路径也报得清楚，而不是算出 0 g', async () => {
    harness = createTestHarness();

    // 入参层的空名单已被 zod 拦（上一条）。但 withPortion 直接调 portionOf，
    // 绕过请求校验——手改库 / 旧版本留下的空名单菜单会从这条路径进来。
    // 此处造的就是那种行：定一餐，然后把快照名单清空。
    const booked = await harness.json<{ slot: { id: string } }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    expect(booked.status).toBe(200);

    // append-only 的触发器不让改事件，所以只能新插一条空名单事件（模拟外部写库）
    harness.db
      .prepare(
        `INSERT INTO meal_events (slot_id, slot_date, meal, type, source, occurred_at)
         VALUES ('2025-06-01:dinner', '2025-06-01', 'dinner', 'replace', 'manual', '2025-06-01T09:00:00Z')`,
      )
      .run();
    const seq = harness.db.prepare('SELECT MAX(seq) AS seq FROM meal_events').get() as { seq: number };
    harness.db
      .prepare("INSERT INTO meal_event_dishes (seq, position, recipe_id, keep_leftover) VALUES (?, 0, 'hongshaopaigu', 0)")
      .run(seq.seq);

    // 读这一餐：份量算不出来（没有用餐者），但错误必须指认清楚，而不是默默给 0 g
    const { status, body } = await harness.json<{ error: string; id?: string }>('/api/slots/2025-06-01:dinner');
    expect(status).toBe(400);
    expect(body.error).toBe('empty_diners');
    expect(body.id).toBe('2025-06-01:dinner');
  });

  it('空名单 / 空菜单 / 不存在的人与菜都以明确错误拒收', async () => {
    harness = createTestHarness();

    // 空名单 / 空菜单在入参层就被拦（与定餐接口同一口径：400 + invalid_request + 逐字段说清原因）
    const noDiners = await preview([], [{ recipeId: 'hongshaopaigu' }]);
    expect(noDiners.status).toBe(400);
    expect(noDiners.body.error).toBe('invalid_request');

    const noDishes = await preview(['mom'], []);
    expect(noDishes.status).toBe(400);
    expect(noDishes.body.error).toBe('invalid_request');

    const badMember = await preview(['mom', 'nobody'], [{ recipeId: 'hongshaopaigu' }]);
    expect(badMember.status).toBe(400);
    expect(badMember.body).toMatchObject({ error: 'unknown_member', memberId: 'nobody' });

    const badRecipe = await preview(['mom'], [{ recipeId: '不存在的菜' }]);
    expect(badRecipe.status).toBe(400);
    expect(badRecipe.body).toMatchObject({ error: 'unknown_recipe', recipeId: '不存在的菜' });

    const duplicate = await preview(['mom'], [{ recipeId: 'hongshaopaigu' }, { recipeId: 'hongshaopaigu' }]);
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe('duplicate_dish');

    // 形状不对（数组都不是）走统一校验错误体
    const malformed = await harness.json<{ error: string; issues: { path: string }[] }>('/api/portion/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: 'mom', dishes: [] }),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_request');
    expect(malformed.body.issues[0]?.path).toBe('diners');
  });
});

/**
 * 年龄现算：分带不能存死，必须在请求时刻按出生年月算出周岁再查表
 * （acceptance criteria：时钟注入测试覆盖小孩跨年龄分带）。
 */
describe('年龄分带（时钟注入的时间旅行）', () => {
  it('大宝（2017-05）随时间走过 6–8 / 9–11 / 12–14 / 15–17 四档，18 岁回成人', async () => {
    harness = createTestHarness();
    const cases: { at: string; age: number; bandId: string; factor: number }[] = [
      { at: '2025-04-30T04:00:00.000Z', age: 7, bandId: 'child_6_8_male', factor: 0.756 },
      { at: '2026-05-01T04:00:00.000Z', age: 9, bandId: 'child_9_11_male', factor: 0.933 },
      { at: '2029-05-01T04:00:00.000Z', age: 12, bandId: 'child_12_14_male', factor: 1.089 },
      { at: '2032-05-01T04:00:00.000Z', age: 15, bandId: 'child_15_17_male', factor: 1.289 },
      { at: '2035-05-01T04:00:00.000Z', age: 18, bandId: 'adult', factor: 1 },
    ];
    for (const expected of cases) {
      harness.clock.set(expected.at);
      const portion = await portionOf(['dabao'], [{ recipeId: 'hongshaopaigu' }]);
      const diner = dinerOf(portion, 'dabao');
      expect(diner).toMatchObject({ ageYears: expected.age, bandId: expected.bandId, factor: expected.factor });
      expect(diner.name).toBe('大宝');
      // 份量随分带一起走（150 × 系数，四舍五入）
      expect(ingredientOf(dishOf(portion, 'hongshaopaigu'), 'pork_ribs').grams).toBe(
        Math.round(150 * expected.factor + 1e-9),
      );
    }
  });

  it('生日月的分界：同一天前后差一天分别落在两档（周岁按月进位现算）', async () => {
    harness = createTestHarness();

    harness.clock.set('2029-04-30T04:00:00.000Z'); // 家庭时区 4-30：还没过 5 月生日
    expect(dinerOf(await portionOf(['dabao'], [{ recipeId: 'hongshaopaigu' }]), 'dabao')).toMatchObject({
      ageYears: 11,
      bandId: 'child_9_11_male',
      factor: 0.933,
    });

    harness.clock.set('2029-05-01T04:00:00.000Z'); // 5 月 1 日：11 岁进 12 岁
    expect(dinerOf(await portionOf(['dabao'], [{ recipeId: 'hongshaopaigu' }]), 'dabao')).toMatchObject({
      ageYears: 12,
      bandId: 'child_12_14_male',
      factor: 1.089,
    });
  });

  it('小宝（2021-09）从最幼档一路走到分性别学龄档', async () => {
    harness = createTestHarness();

    harness.clock.set('2026-08-31T04:00:00.000Z');
    expect(dinerOf(await portionOf(['xiaobao'], [{ recipeId: 'hongshaopaigu' }]), 'xiaobao')).toMatchObject({
      ageYears: 4,
      bandId: 'preschool_4_5',
      factor: 0.539,
    });

    harness.clock.set('2027-09-01T04:00:00.000Z'); // 满 6 岁：进 6–8 女
    expect(dinerOf(await portionOf(['xiaobao'], [{ recipeId: 'hongshaopaigu' }]), 'xiaobao')).toMatchObject({
      ageYears: 6,
      bandId: 'child_6_8_female',
      factor: 0.861,
    });
  });

  it('不满最幼分带的小孩按最幼档兜底，并在档位说明里讲明（不静默当成成人）', async () => {
    harness = createTestHarness();

    harness.clock.set('2022-06-01T04:00:00.000Z'); // 小宝才 9 个月大
    const diner = dinerOf(await portionOf(['xiaobao'], [{ recipeId: 'hongshaopaigu' }]), 'xiaobao');
    expect(diner).toMatchObject({ ageYears: 0, bandId: 'preschool_2_3', factor: 0.408 });
    expect(diner.note).toContain('2');
  });

  it('满 18 岁还挂在画像「小孩」上的人按成人折算，并在说明里讲明', async () => {
    harness = createTestHarness();

    harness.clock.set('2040-01-01T04:00:00.000Z');
    const diner = dinerOf(await portionOf(['dabao'], [{ recipeId: 'hongshaopaigu' }]), 'dabao');
    expect(diner).toMatchObject({ ageYears: 22, bandId: 'adult', factor: 1 });
    expect(diner.note).toContain('18');
  });

  it('画像标为大人的人不折算（即使录了出生年月，大人档说了算）', async () => {
    harness = createTestHarness();
    harness.db
      .prepare("UPDATE members SET birth_month = '1990-03' WHERE id = 'dad'")
      .run();

    const diner = dinerOf(await portionOf(['dad'], [{ recipeId: 'hongshaopaigu' }]), 'dad');
    expect(diner).toMatchObject({ kind: 'adult', ageYears: null, bandId: 'adult', factor: 1 });
  });
});

/**
 * 规则表（acceptance criteria：WS/T 554 折算系数表入库、来源注明）。
 * 走 `GET /api/portion/rules` 读出，断言的既是「表在库」也是「怎么推出来的」——
 * 系数必须等于分带能量 ÷ 同性别成人锚点，两处对不上就是入库时抄错了。
 */
describe('规则表与来源', () => {
  async function rules(): Promise<PortionRules> {
    const { status, body } = await harness.json<PortionRulesResponse>('/api/portion/rules');
    expect(status).toBe(200);
    return body.rules;
  }

  it('成人锚点与分带系数自洽：系数 = 该带能量 ÷ 同性别成人锚点', async () => {
    harness = createTestHarness();

    const table = await rules();
    // 留量上浮系数（#22）现在是家规里的**配置值**（默认 1.5×）；它兑现与否看每份菜单的实际引用，
    // 所以这里断言的是「规则表读得出家规」，而不是「每份菜单都上浮」。
    expect(table.uplift).toBe(1.5);
    const anchors = new Map(table.adults.map((anchor) => [anchor.gender, anchor.dailyKcal]));
    expect(anchors.get('male')).toBe(2250);
    expect(anchors.get('female')).toBe(1800);
    expect(table.adults.every((anchor) => anchor.source.length > 0)).toBe(true);

    // WS/T 554—2017 表 1 的八条学龄带
    const ageBands = table.bands.filter((band) => band.basis === 'wst554_energy');
    expect(ageBands.map((band) => band.id).sort()).toEqual([
      'child_12_14_female',
      'child_12_14_male',
      'child_15_17_female',
      'child_15_17_male',
      'child_6_8_female',
      'child_6_8_male',
      'child_9_11_female',
      'child_9_11_male',
    ]);
    expect(ageBands.map((band) => [band.id, band.referenceEnergyKcal])).toEqual([
      ['child_6_8_male', 1700],
      ['child_6_8_female', 1550],
      ['child_9_11_male', 2100],
      ['child_9_11_female', 1900],
      ['child_12_14_male', 2450],
      ['child_12_14_female', 2100],
      ['child_15_17_male', 2900],
      ['child_15_17_female', 2350],
    ]);

    for (const band of ageBands) {
      const anchor = band.gender === 'male' ? anchors.get('male')! : anchors.get('female')!;
      expect(Math.abs(band.coefficient - band.referenceEnergyKcal! / anchor), band.id).toBeLessThan(0.001);
      expect(band.source).toContain('WS/T 554');
    }
  });

  it('能量列是权威列：改了它，份量真的跟着变（系数不会静默停在旧值）', async () => {
    harness = createTestHarness();

    // 改权威能量值（模拟标准修订 / 入库时改错后修正）：6–8 岁男 1700 → 1800 kcal
    harness.db.prepare("UPDATE portion_reference_energy SET daily_kcal = 1800 WHERE band_id = 'child_6_8_male'").run();

    // 系数与份量都必须跟着变：1800 ÷ 2250 = 0.8（而非旧值 0.756）
    const table = await rules();
    expect(table.bands.find((band) => band.id === 'child_6_8_male')?.coefficient).toBeCloseTo(0.8, 3);

    const { body } = await harness.json<{ portion: MenuPortion }>('/api/portion/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['dabao'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    // 150 g 排骨 × 0.8 = 120 g（若还读旧系数 0.756 会得 113 g）
    expect(body.portion.dishes[0]?.ingredients[0]?.grams).toBe(120);
  });

  it('系数是派生值：与「能量 ÷ 锚点」同口径（改了派生算式会被这条拦住）', async () => {
    harness = createTestHarness();

    // 这条不依赖改数据，直接撞「系数到底从哪来」：
    // 若把 loadBands 的 COALESCE(e.daily_kcal / a.daily_kcal, b.coefficient) 改成只看 b.coefficient，
    // 下面「系数与能量除法的偏差」仍然成立（当前种子两者相同）——所以额外的护栏是把
    // 存储列改成一个**与能量不一致**的值，看运行时听谁的。
    harness.db.prepare("UPDATE portion_age_bands SET coefficient = 9.999 WHERE id = 'child_6_8_male'").run();

    // 权威列说了算：仍然是 1700 ÷ 2250 = 0.756（不是被改坏的 9.999）
    const table = await rules();
    expect(table.bands.find((band) => band.id === 'child_6_8_male')?.coefficient).toBeCloseTo(0.756, 3);

    const { body } = await harness.json<{ portion: MenuPortion }>('/api/portion/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['dabao'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    // 150 g × 0.756 = 113 g；若读了被改坏的存储列，会得 1500 g
    expect(body.portion.dishes[0]?.ingredients[0]?.grams).toBe(113);
  });

  it('餐次占比入库：全天量 → 单餐量的换算依据（总纲 §5-2 要求「规则表存」）', async () => {
    harness = createTestHarness();

    const table = await rules();
    // WS/T 554—2017 §3.3 原文：早 25–30% / 午 35–40% / 晚 30–35%
    expect(table.mealShares.map((share) => [share.meal, share.minShare, share.maxShare])).toEqual([
      ['breakfast', 0.25, 0.3],
      ['lunch', 0.35, 0.4],
      ['dinner', 0.3, 0.35],
    ]);
    // 展示顺序是显式的 sort_order（0/1/2），不是字母序、也不是靠钟点冒充
    expect(table.mealShares.map((share) => [share.meal, share.sortOrder])).toEqual([
      ['breakfast', 0],
      ['lunch', 1],
      ['dinner', 2],
    ]);
    expect(table.mealShares.every((share) => share.source.includes('WS/T 554'))).toBe(true);
    // 三餐占比区间与 100% 大致对得上（标准给的是区间，不是精确值）
    const midSum = table.mealShares.reduce((sum, share) => sum + (share.minShare + share.maxShare) / 2, 0);
    expect(midSum).toBeCloseTo(1, 1);
  });

  it('学龄前两档按宝塔推荐量篮比值推导，并如实标注 OCR 未复核', async () => {
    harness = createTestHarness();

    const table = await rules();
    const preschool = table.bands.filter((band) => band.basis === 'preschool_basket');
    expect(preschool.map((band) => band.id)).toEqual(['preschool_2_3', 'preschool_4_5']);
    expect(preschool.map((band) => [band.minAge, band.maxAge])).toEqual([
      [2, 3],
      [4, 5],
    ]);
    // 篮比值 = (谷类中值 + 蔬菜中值 + 畜禽鱼中值) ÷ 成人同口径 765 g
    const basket = (population: string): number => {
      const amount = (groupKey: string): number => {
        const row = table.recommendedAmounts.find(
          (item) => item.population === population && item.groupKey === groupKey,
        )!;
        return ((row.minGrams ?? row.maxGrams) + row.maxGrams) / 2;
      };
      return (amount('grain') + amount('vegetable') + amount('animal')) / 765;
    };
    expect(Math.abs(preschool[0]!.coefficient - basket('preschool_2_3'))).toBeLessThan(0.001);
    expect(Math.abs(preschool[1]!.coefficient - basket('preschool_4_5'))).toBeLessThan(0.001);
    // 数值来自官方图 OCR：库里的来源必须写明「未复核」，不能装作已经核准
    expect(preschool.every((band) => band.source.includes('OCR'))).toBe(true);
  });

  it('推荐量逐条带来源：成人宝塔 2022 + 学龄前宝塔，区间与单位齐全', async () => {
    harness = createTestHarness();

    const table = await rules();
    expect(table.recommendedAmounts.every((row) => row.source.length > 0 && row.unit.length > 0)).toBe(true);
    expect(new Set(table.recommendedAmounts.map((row) => row.population))).toEqual(
      new Set(['adult', 'preschool_2_3', 'preschool_4_5']),
    );

    const grain = table.recommendedAmounts.find(
      (row) => row.population === 'adult' && row.groupKey === 'grain',
    );
    expect(grain).toMatchObject({ minGrams: 200, maxGrams: 300, groupLabel: '谷类' });
    expect(grain?.source).toContain('2022');

    // 只看上限的条目（盐）minGrams 为空而不是 0——「0 克盐」和「没写上限」不是一回事
    const salt = table.recommendedAmounts.find((row) => row.population === 'adult' && row.groupKey === 'salt');
    expect(salt?.minGrams).toBeNull();
    expect(salt?.maxGrams).toBe(5);

    // 本项目不录学龄儿童宝塔：它的分带与 WS/T 554 的分带对不齐（文件头与报告说明取舍）
    expect(table.recommendedAmounts.some((row) => row.population.startsWith('school_age'))).toBe(false);
  });

  it('成人档不折算、不封顶：一条 any 档，minAge 18', async () => {
    harness = createTestHarness();

    const table = await rules();
    const adult = table.bands.find((band) => band.id === 'adult');
    expect(adult).toMatchObject({ gender: 'any', minAge: 18, maxAge: null, coefficient: 1, basis: 'adult_anchor' });
  });
});

/**
 * 餐槽内嵌份量（acceptance criteria：菜单 API 显示每道菜生重）。
 * 定好的菜单经 `GET /api/slots/:id` 直接带出份量，界面不必自己算：算的规则只有服务端一份。
 */
describe('餐槽里的份量', () => {
  async function bookSlot(id: string, diners: string[], recipes: string[]): Promise<void> {
    const { status } = await harness.json(`/api/slots/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners, dishes: recipes.map((recipeId) => ({ recipeId })) }),
    });
    expect(status).toBe(200);
  }

  async function slotPortion(id: string): Promise<MenuPortion | null> {
    const { status, body } = await harness.json<SlotResponse>(`/api/slots/${id}`);
    expect(status).toBe(200);
    return body.slot.portion;
  }

  it('未定的餐槽没有份量（没有菜单就没有份量），定了就有', async () => {
    harness = createTestHarness();

    expect(await slotPortion('2025-06-01:dinner')).toBeNull();

    await bookSlot('2025-06-01:dinner', ['mom', 'dad'], ['hongshaopaigu']);
    const portion = (await slotPortion('2025-06-01:dinner'))!;
    expect(portion.diners.map((diner) => diner.name)).toEqual(['妈妈', '爸爸']);
    expect(ingredientOf(dishOf(portion, 'hongshaopaigu'), 'pork_ribs').grams).toBe(300);
  });

  it('餐槽列表也带份量（首屏能看到每道菜多少克，不必再打一次接口）', async () => {
    harness = createTestHarness();
    await bookSlot('2025-06-01:dinner', ['mom', 'dad'], ['hongshaopaigu']);

    const { status, body } = await harness.json<SlotsResponse>('/api/slots?days=2');
    expect(status).toBe(200);
    const decided = body.slots.find((slot) => slot.id === '2025-06-01:dinner')!;
    expect(ingredientOf(dishOf(decided.portion!, 'hongshaopaigu'), 'pork_ribs').grams).toBe(300);
    // 未定的餐槽 portion 为 null（不是缺字段：形状稳定，前端不必分叉）
    expect(body.slots.find((slot) => slot.id === '2025-06-02:lunch')?.portion).toBeNull();
  });

  it('定餐/改餐的响应直接带新份量（保存后不必再读一次）', async () => {
    harness = createTestHarness();

    const first = await harness.json<{ slot: { portion: MenuPortion } }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    expect(ingredientOf(dishOf(first.body.slot.portion, 'hongshaopaigu'), 'pork_ribs').grams).toBe(150);

    const second = await harness.json<{ slot: { portion: MenuPortion } }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom', 'dad'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    expect(ingredientOf(dishOf(second.body.slot.portion, 'hongshaopaigu'), 'pork_ribs').grams).toBe(300);
  });

  it('餐槽里的份量与实际用餐者名单一致（临时改过名单的餐也照实际名单算）', async () => {
    harness = createTestHarness();
    await bookSlot('2025-06-02:dinner', ['mom', 'dabao'], ['kelejichi']);

    const portion = (await slotPortion('2025-06-02:dinner'))!;
    // 妈妈 1 + 大宝 0.756 = 1.756 → 鸡翅 130 × 1.756 = 228.28 → 228；固定量的油不变
    expect(portion.factorSum).toBeCloseTo(1.756, 6);
    expect(ingredientOf(dishOf(portion, 'kelejichi'), 'chicken_wings').grams).toBe(228);
    expect(ingredientOf(dishOf(portion, 'kelejichi'), 'cooking_oil').grams).toBe(10);
  });

  it('拨钟之后同一份菜单的份量随年龄分带重算（份量是现算的，不是定餐时冻住的）', async () => {
    harness = createTestHarness();
    await bookSlot('2025-06-01:dinner', ['mom', 'dabao'], ['hongshaopaigu']);

    expect(ingredientOf(dishOf((await slotPortion('2025-06-01:dinner'))!, 'hongshaopaigu'), 'pork_ribs').grams).toBe(
      Math.round(150 * 1.756 + 1e-9), // 8 岁
    );

    harness.clock.set('2029-05-01T04:00:00.000Z'); // 大宝 12 岁
    const later = (await slotPortion('2025-06-01:dinner'))!;
    expect(dinerOf(later, 'dabao')).toMatchObject({ ageYears: 12, bandId: 'child_12_14_male' });
    expect(ingredientOf(dishOf(later, 'hongshaopaigu'), 'pork_ribs').grams).toBe(Math.round(150 * (1 + 1.089) + 1e-9));
  });

  it('取消之后份量一起消失（取消 = 没有这一餐）', async () => {
    harness = createTestHarness();
    await bookSlot('2025-06-01:dinner', ['mom'], ['hongshaopaigu']);

    const { status } = await harness.json('/api/slots/2025-06-01:dinner', { method: 'DELETE' });
    expect(status).toBe(200);
    expect(await slotPortion('2025-06-01:dinner')).toBeNull();
  });

  it('家人后来被删，历史菜单的份量照算（快照里的人按成人份，并在说明里讲明）', async () => {
    harness = createTestHarness();
    await bookSlot('2025-06-01:dinner', ['mom', 'xiaobao'], ['hongshaopaigu']);
    expect(dinerOf((await slotPortion('2025-06-01:dinner'))!, 'xiaobao')).toMatchObject({
      bandId: 'preschool_2_3',
      factor: 0.408,
    });

    // 删掉小宝（M1 没有删家人的入口，但库层面可能发生；菜单里的名单是当时的快照）
    harness.db.prepare("DELETE FROM members WHERE id = 'xiaobao'").run();

    const portion = (await slotPortion('2025-06-01:dinner'))!;
    expect(portion.factorSum).toBeCloseTo(2, 6);
    const orphan = dinerOf(portion, 'xiaobao');
    expect(orphan).toMatchObject({ kind: 'adult', bandId: 'adult', factor: 1 });
    expect(orphan.note).toContain('已没有这个人');
    expect(ingredientOf(dishOf(portion, 'hongshaopaigu'), 'pork_ribs').grams).toBe(300);

    // 而草稿菜单里写一个不存在的人还是明确报错（那份名单是现在写的，不是历史快照）
    const { status, body } = await preview(['mom', 'xiaobao'], [{ recipeId: 'hongshaopaigu' }]);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'unknown_member', memberId: 'xiaobao' });
  });
});

/**
 * 生熟 / 同类互换（WS/T 554 附录 A）：本票只提供查询与换算能力，
 * 不做买菜清单聚合（#23）。
 */
describe('生熟与同类互换表', () => {
  async function groups(): Promise<ExchangeGroup[]> {
    const { status, body } = await harness.json<ExchangeTableResponse>('/api/portion/exchange');
    expect(status).toBe(200);
    return body.groups;
  }

  it('七组互换表入库，每组带基准与来源（主食、蔬菜、水果、鱼肉、肉、大豆、奶）', async () => {
    harness = createTestHarness();

    const table = await groups();
    expect(table.map((group) => group.id).sort()).toEqual([
      'dairy',
      'fish',
      'fruit',
      'meat',
      'soy',
      'staple',
      'vegetable',
    ]);
    expect(table.every((group) => group.source.includes('WS/T 554'))).toBe(true);

    const staple = table.find((group) => group.id === 'staple')!;
    expect(staple).toMatchObject({ anchorName: '大米（生）', anchorGrams: 50 });
    // 附录 A 的原文数值：50 g 大米 ≈ 米饭（粳米）110 g ≈ 馒头/花卷 80 g ≈ 米粥 375 g
    const byName = new Map(staple.items.map((item) => [item.name, item.grams]));
    expect(byName.get('米饭（粳米）')).toBe(110);
    expect(byName.get('馒头 / 花卷')).toBe(80);
    expect(byName.get('米粥')).toBe(375);
    // 能对上食材字典的条目挂上 id（#23 买菜聚合用）；对不上的（市品口径）为 null
    expect(staple.items.find((item) => item.name === '大米')?.ingredientId).toBe('rice');
    expect(staple.items.find((item) => item.name === '米饭（粳米）')?.ingredientId).toBeNull();
  });

  it('换算：100 g 大米等价于多少米饭/馒头/米粥', async () => {
    harness = createTestHarness();

    const { status, body } = await harness.json<ExchangeConversionResponse>(
      '/api/portion/exchange/convert?from=staple_rice_raw&grams=100',
    );
    expect(status).toBe(200);
    expect(body.conversion).toMatchObject({ grams: 100 });
    expect(body.conversion.group.id).toBe('staple');
    expect(body.conversion.from.name).toBe('大米');

    const byName = new Map(body.conversion.equivalents.map((entry) => [entry.item.name, entry.grams]));
    expect(byName.get('米饭（粳米）')).toBe(220);
    expect(byName.get('馒头 / 花卷')).toBe(160);
    expect(byName.get('米粥')).toBe(750);
    expect(byName.get('大米')).toBe(100);
  });

  it('换算双向成立：米饭换回生米', async () => {
    harness = createTestHarness();

    const { body } = await harness.json<ExchangeConversionResponse>(
      '/api/portion/exchange/convert?from=staple_rice_japonica&grams=220',
    );
    const byName = new Map(body.conversion.equivalents.map((entry) => [entry.item.name, entry.grams]));
    expect(byName.get('大米')).toBe(100);
    // 四舍五入到一位小数，避免界面上出现 219.99999
    expect(byName.get('米粥')).toBe(750);
  });

  it('不认识的条目返回 404 并指认它（换算要能说清是哪一条没对上）', async () => {
    harness = createTestHarness();

    const { status, body } = await harness.json<{ error: string; itemId: string }>(
      '/api/portion/exchange/convert?from=不存在的条目&grams=100',
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown_exchange_item', itemId: '不存在的条目' });
  });

  it('克数缺失或非法由 zod 拦下', async () => {
    harness = createTestHarness();

    for (const query of ['from=staple_rice_raw', 'from=staple_rice_raw&grams=0', 'from=staple_rice_raw&grams=abc']) {
      const { status, body } = await harness.json<{ error: string }>(`/api/portion/exchange/convert?${query}`);
      expect(status, query).toBe(400);
      expect(body.error, query).toBe('invalid_request');
    }
  });
});
