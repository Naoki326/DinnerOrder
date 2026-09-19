import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { familyRulesAffectGrocery } from '../domain/grocery.js';
import type {
  FamilyRules,
  FamilyRulesResponse,
  GroceryList,
  GroceryListResponse,
  MealSlot as SlotJson,
  MenuPortion,
  SlotResponse,
} from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 买菜清单（#23、总纲 §2.7、spec S8）：跨已定餐槽聚合同一食材生重 + 手工行 + 过期重算 + 归档。
 *
 * 本文件守的四条不变量：
 *
 * 1. **聚合与份量引擎同源**：清单里每个食材的克数 = 各餐 `GET /api/slots/:id` 读数之和。
 *    自己再乘一遍系数（而不是复用 `portionOf`）就会在这里露馅——这是「份量只有一处」的回归网。
 * 2. **只买还没上桌的餐**：未定的餐、已过的餐、以及「吃剩的」那一餐都不加采购
 *    （「吃剩的」吃的是被引用那一餐多做的那几道，再算一遍就是双份）。
 * 3. **留量上浮真的计入**：#22 已把「留量标记 ∧ 有效引用」接进份量引擎，清单天然含上浮。
 *    这条不变量必须有测试证明（AC 第三条），否则「已接进去」只是一句话。
 * 4. **过期只标不动行；重算时勾选按食材继承、手工行保留**（总纲 §2.7）。
 *
 * 测试时钟起点 2025-06-01T10:00Z = 家庭时区 06-01 18:00：06-01 的午餐已过、晚餐还没。
 * 所以取材一律用 06-02 及以后（`ALL` 全员用餐，与其余 API 测试同口径）。
 */

const ALL = ['mom', 'dad', 'dabao', 'xiaobao'];

async function book(id: string, payload: unknown): Promise<void> {
  const { status, body } = await harness.json<{ slot?: SlotJson; error?: string; issues?: unknown }>(
    `/api/slots/${id}`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
  );
  expect(status, JSON.stringify(body)).toBe(200);
}

async function cancel(id: string): Promise<void> {
  const { status } = await harness.json(`/api/slots/${id}`, { method: 'DELETE' });
  expect(status).toBe(200);
}

/** 改家规（评审修复 ① 的入口：改会影响聚合的值 → 清单要过期） */
async function patchRules(patch: Record<string, number>): Promise<{ status: number; rules: FamilyRules }> {
  const { status, body } = await harness.json<FamilyRulesResponse>('/api/family-rules', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return { status, rules: body.rules };
}

/** 库里的家规那一行（验证「拒收之后没改进去」这类事） */
async function familyRulesRow(): Promise<FamilyRules> {
  const { status, body } = await harness.json<FamilyRulesResponse>('/api/family-rules');
  expect(status).toBe(200);
  return body.rules;
}

async function list(): Promise<GroceryList | null> {
  const { status, body } = await harness.json<GroceryListResponse>('/api/grocery');
  expect(status).toBe(200);
  return body.list;
}

async function listOrFail(): Promise<GroceryList> {
  const current = await list();
  expect(current, '这会儿应该有一份进行中的清单').not.toBeNull();
  return current!;
}

/** 把几餐的份量读数逐个食材加起来——清单必须与它相等（谁多乘一次系数都会在这里露馅） */
async function portionSums(slotIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const slotId of slotIds) {
    const { status, body } = await harness.json<SlotResponse>(`/api/slots/${slotId}`);
    expect(status).toBe(200);
    const portion = body.slot.portion as MenuPortion;
    for (const dish of portion.dishes) {
      for (const ingredient of dish.ingredients) {
        totals.set(ingredient.ingredientId, (totals.get(ingredient.ingredientId) ?? 0) + ingredient.grams);
      }
    }
  }
  return totals;
}

function itemOf(grocery: GroceryList, ingredientId: string) {
  const item = grocery.items.find((entry) => entry.ingredientId === ingredientId);
  if (!item) throw new Error(`清单里没有这个食材：${ingredientId}`);
  return item;
}

/** 一定有的克数（聚合行的 grams 是 number | null，测试里只对聚合行取值） */
function gramsOf(grocery: GroceryList, ingredientId: string): number {
  const grams = itemOf(grocery, ingredientId).grams;
  if (grams === null) throw new Error(`这个食材没有克数：${ingredientId}`);
  return grams;
}

describe('聚合（总纲 §2.7：跨已定餐槽同一食材生重合计 + 来源）', () => {
  it('两餐的同一食材合成一行（生重合计），并记下来自哪几餐的哪道菜', async () => {
    harness = createTestHarness();
    // 红烧排骨 150 g 猪排骨 + 冬瓜排骨汤 60 g 猪排骨：跨两餐、同类食材合一行
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'suanrongcaixin' }] });
    await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'dongguapaigutang' }] });

    const grocery = await listOrFail();
    const ribs = itemOf(grocery, 'pork_ribs');
    const sums = await portionSums(['2025-06-02:lunch', '2025-06-02:dinner']);
    expect(ribs.grams).toBe(sums.get('pork_ribs'));
    expect(ribs.grams).toBeGreaterThan(0);
    // 来源点名到餐与菜（原型 v1 行内那句「来自 N 道菜：…」）
    expect(ribs.sources.map((source) => `${source.slotId}·${source.recipeName}`)).toEqual([
      '2025-06-02:lunch·红烧排骨',
      '2025-06-02:dinner·冬瓜排骨汤',
    ]);
    // 分类来自互换表已挂的食材指针（不另造分类表）：猪排骨 → 肉禽
    expect(ribs.category).toBe('肉禽');
    // 互换表里没挂指针的食材落「其他」（菜心不在附录 A 的蔬菜条目里）：
    // 宁可粗一点也不建第二套分类——分类只从已有的信息推（台账明写别造新表）
    expect(itemOf(grocery, 'choy_sum').category).toBe('其他');
    expect(itemOf(grocery, 'garlic').category).toBe('其他');
    expect(grocery.mealCount).toBe(2);
    expect(grocery.status).toBe('active');
    expect(grocery.stale).toBe(false);
  });

  it('每一个食材都与份量引擎的读数逐个对得上（清单不自己重算份量）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'kelejichi' }, { recipeId: 'fanqiechaodan' }],
    });
    await book('2025-06-03:lunch', { diners: ['mom', 'dabao'], dishes: [{ recipeId: 'mapodoufu' }] });

    const grocery = await listOrFail();
    const sums = await portionSums(['2025-06-02:lunch', '2025-06-03:lunch']);
    for (const [ingredientId, grams] of sums) {
      expect(itemOf(grocery, ingredientId).grams, ingredientId).toBe(grams);
    }
  });

  it('未定的餐、已过截止时刻的餐、以及「吃剩的」那一餐都不加采购', async () => {
    harness = createTestHarness();
    // 未定的一餐（06-03:lunch 不派）
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'qingzhengluyu' }] });
    // 「吃剩的」那一餐：吃的是午餐多做的那几道，本身不加采购
    await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'qingzhengluyu', keepLeftover: true }],
    });
    await book('2025-06-02:dinner', { diners: ALL, dishes: [], leftoverOf: '2025-06-02:lunch' });

    const grocery = await listOrFail();
    // 鲈鱼只来自午餐那一道（晚餐是吃剩的，不另算一份）
    expect(itemOf(grocery, 'seabass').sources.map((source) => source.slotId)).toEqual(['2025-06-02:lunch']);
    expect(grocery.mealCount).toBe(1);

    // 时间走过 06-02：那一餐上了桌，重算后不再是要买的东西（“改餐 → 手动重算”）：
    // 时间的推移不是菜单变化，清单不会自己重算（也不会自己过期）——这一点下一条用例再复验
    harness.clock.set('2025-06-03T10:00:00.000Z');
    const after = await recalculate();
    expect(after.mealCount).toBe(0);
    expect(after.items).toEqual([]);
  });

  it('0 克项（导入期「待重标」）列出并标记，不静默跳过', async () => {
    harness = createTestHarness();
    // 模糊份量的草稿（迁移 005：adult_grams = 0 表示「还没重标」）
    harness.db
      .prepare("UPDATE recipe_ingredients SET adult_grams = 0 WHERE recipe_id = 'xiangguhuaji' AND ingredient_id = 'shiitake'")
      .run();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'xiangguhuaji' }] });

    const grocery = await listOrFail();
    const mushrooms = itemOf(grocery, 'shiitake');
    expect(mushrooms.needsRelabel).toBe(true);
    expect(mushrooms.grams).toBe(0);
    // 同一道菜里克数正常的食材照常聚合（标记只挂在那一条上）
    expect(itemOf(grocery, 'chicken_legs').needsRelabel).toBe(false);
    expect(itemOf(grocery, 'chicken_legs').grams).toBeGreaterThan(0);
  });

  it('生熟换算参考从互换表现算（没有清单也能给：基准句恒在）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'danchaofan' }] });
    const grocery = await listOrFail();
    expect(grocery.exchangeNote).toContain('生重为准');
    expect(grocery.exchangeNote).toContain('米生:熟 ≈ 1:2.2');
    expect(grocery.exchangeNote).toContain('肉熟重约 ×0.7');
  });

  it('没定过任何餐时没有清单（不凭空造一张空的）', async () => {
    harness = createTestHarness();
    const { body } = await harness.json<GroceryListResponse>('/api/grocery');
    expect(body.list).toBeNull();
    expect(body.archivedCount).toBe(0);
  });
});

describe('留量上浮计入聚合（AC 第三条）', () => {
  it('晚餐吃剩的一餐把午餐的留量菜按家规上浮：同一份食材的合计真的变大', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }, { recipeId: 'suanrongcaixin' }],
    });
    const before = await listOrFail();
    const beforeRibs = gramsOf(before, 'pork_ribs');

    // 晚餐预定成吃中午剩的 → 「有效引用」成立 → 午餐的留量菜按 1.5× 上浮
    await book('2025-06-02:dinner', { diners: ALL, dishes: [], leftoverOf: '2025-06-02:lunch' });
    const recalculated = await recalculate();
    const afterRibs = gramsOf(recalculated, 'pork_ribs');

    expect(afterRibs).toBeGreaterThan(beforeRibs);
    // 家规上浮系数（默认 1.5）真的乘进去了：两个读数之比就是那个系数
    // （逐项乘完再取整，所以比值不会刚好是 1.5——这里比较的是「真的上浮了且幅度对」）
    const rules = harness.db.prepare('SELECT leftover_uplift FROM family_rules WHERE id = 1').get() as {
      leftover_uplift: number;
    };
    expect(afterRibs / beforeRibs).toBeCloseTo(rules.leftover_uplift, 1);
    // 没标留量的素菜不上浮：引用有没有生效都不变
    expect(gramsOf(recalculated, 'choy_sum')).toBe(gramsOf(before, 'choy_sum'));
  });
});

describe('过期与手动重算（总纲 §2.7）', () => {
  it('改餐 → 标记过期（带原因、行不动）；重算 → 勾选按食材继承、手工行保留', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    const created = await listOrFail();

    // 勾一行 + 加一条手工行
    await harness.json(`/api/grocery/items/${itemOf(created, 'pork_ribs').id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checked: true }),
    });
    await harness.json('/api/grocery/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '一次性手套' }),
    });

    // 改餐（换一道菜）→ 清单过期，但行原样留着（勾选与手工行正是重算要继承的东西）
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    const stale = await listOrFail();
    expect(stale.stale).toBe(true);
    // 存的是结构：原因枚举 + 哪一餐（不是渲染好的那句中文，见下方「过期原因存结构」）
    expect(stale.staleReason).toBe('menu_changed');
    expect(stale.staleSlotId).toBe('2025-06-02:lunch');
    expect(itemOf(stale, 'pork_ribs').checked).toBe(true);
    expect(stale.items.some((item) => item.kind === 'manual' && item.name === '一次性手套')).toBe(true);

    // 重算：换成新菜单的聚合 + 勾选按食材继承（鸡翅没勾过 → 不勾）+ 手工行保留 + 过期标记清掉
    const recalculated = await recalculate();
    expect(recalculated.stale).toBe(false);
    expect(recalculated.staleReason).toBeNull();
    expect(recalculated.staleSlotId).toBeNull();
    expect(itemOf(recalculated, 'chicken_wings').checked).toBe(false);
    expect(recalculated.items.find((item) => item.ingredientId === 'pork_ribs')).toBeUndefined();
    expect(
      recalculated.items.filter((item) => item.kind === 'manual').map((item) => item.name),
    ).toEqual(['一次性手套']);
  });

  it('重算时同一食材跨餐仍保留勾选（勾选按食材继承，不按行号）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    const created = await listOrFail();
    await harness.json(`/api/grocery/items/${itemOf(created, 'pork_ribs').id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checked: true }),
    });

    // 再加一餐，排骨又从另一道汤里来一份：同一食材（pork_ribs）的勾选跟着过来
    await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'dongguapaigutang' }] });
    expect((await listOrFail()).stale).toBe(true);
    const recalculated = await recalculate();
    const ribs = itemOf(recalculated, 'pork_ribs');
    expect(ribs.checked).toBe(true);
    expect(ribs.sources).toHaveLength(2);
  });

  it('取消一餐也会标记过期（理由说清是哪一餐取消了）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    await listOrFail();
    await cancel('2025-06-02:lunch');
    const stale = await listOrFail();
    expect(stale.stale).toBe(true);
    expect(stale.staleReason).toBe('cancelled');
    expect(stale.staleSlotId).toBe('2025-06-02:lunch');
  });

  it('内容一模一样的「改餐」不标过期（同一次提交不追事件，也就不该说菜单变了）', async () => {
    harness = createTestHarness();
    const dishes = [{ recipeId: 'hongshaopaigu' }];
    await book('2025-06-02:lunch', { diners: ALL, dishes });
    const created = await listOrFail();
    expect(created.stale).toBe(false);
    // 手机双击保存：服务端对相同内容不追事件，清单也不该因此过期
    await book('2025-06-02:lunch', { diners: ALL, dishes });
    expect((await listOrFail()).stale).toBe(false);
  });

  it('手动重算是显式动作：过期清单在重算之前一直保持过期（不自动重算）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    await listOrFail();
    await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    // 读两次都还是过期的原样（新菜还没进来）——「改餐 → 标记过期 → **手动**重算」
    const first = await listOrFail();
    const second = await listOrFail();
    expect(first.stale).toBe(true);
    expect(second.stale).toBe(true);
    expect(second.items.find((item) => item.ingredientId === 'tomato')).toBeUndefined();
  });
});

/**
 * 家规改动 → 清单过期（#23 评审修复 ①）。
 *
 * 家规里有两个值**直接改变聚合结果**：`leftover_uplift`（份量引擎读它算每道菜的克数）与
 * `lunch/dinner_cutoff_hour`（决定 `slot.editable`，而 `buyableSlots` 用它筛「还在可买范围内的餐」）。
 * 改了它们而不标过期，进行中的清单会**静默地**与新口径不一致：用户看不到任何提示，
 * 重算后克数变了也不知道为什么。冷藏期天数不影响清单的任何一个数，所以改它**不**标。
 */
describe('家规改动 → 清单过期（评审修复 ①）', () => {
  it('改留量上浮系数 → 进行中的清单变过期，原因说得对（哪一档 + 没有具体哪一餐）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }],
    });
    // 晚餐预定成吃中午剩的 → 「有效引用」成立 → 那份留量菜真的按上浮系数算克数
    await book('2025-06-02:dinner', { diners: ALL, dishes: [], leftoverOf: '2025-06-02:lunch' });
    const before = await listOrFail();
    expect(before.stale).toBe(false);

    const patched = await patchRules({ leftoverUplift: 3 });
    expect(patched.rules.leftoverUplift).toBe(3);

    const stale = await listOrFail();
    expect(stale.stale).toBe(true);
    expect(stale.staleReason).toBe('family_rules_changed');
    // 家规改动没有「哪一餐」（schema 上成对：家规类不带槽），警告卡那句自己说完整
    expect(stale.staleSlotId).toBeNull();

    // 重算后：过期标记清掉，且**克数真的跟着新系数变了**（这正是必须标过期的理由）
    const recalculated = await recalculate();
    expect(recalculated.stale).toBe(false);
    expect(gramsOf(recalculated, 'pork_ribs')).toBeGreaterThan(gramsOf(before, 'pork_ribs'));
  });

  it('改午/晚截止时刻 → 同样标过期（它决定清单该含哪几餐）', async () => {
    harness = createTestHarness();
    // 06-01 18:00（家庭时区）：晚餐 21:00 截止，所以 06-01 晚餐现在还可定、算「要买」
    await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    const before = await listOrFail();
    expect(before.mealCount).toBe(1);
    expect(before.stale).toBe(false);

    // 把晚餐截止提到 17 点：18:00 已经过了 → 这一餐不再是要买的东西（聚合口径变了）
    const patched = await patchRules({ dinnerCutoffHour: 17 });
    expect(patched.rules.dinnerCutoffHour).toBe(17);
    const stale = await listOrFail();
    expect(stale.stale).toBe(true);
    expect(stale.staleReason).toBe('family_rules_changed');
    expect(stale.mealCount).toBe(1); // 行与餐数原样留着，重算才动

    const recalculated = await recalculate();
    expect(recalculated.mealCount).toBe(0);
    expect(recalculated.items).toEqual([]);
  });

  it('改午餐截止时刻同理（同一判据里两个时刻都要看）', async () => {
    harness = createTestHarness();
    // 拨到 06-01 10:00（家庭时区）：午餐 14:00 截止，现在还来得及定、算「要买」
    harness.clock.set('2025-06-01T02:00:00.000Z');
    await book('2025-06-01:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    expect((await listOrFail()).mealCount).toBe(1);

    // 把午餐截止提到 09 点：现在（10:00）已经过了 → 中午那一餐不再是要买的东西
    await patchRules({ lunchCutoffHour: 9 });
    const stale = await listOrFail();
    expect(stale.stale).toBe(true);
    expect(stale.staleReason).toBe('family_rules_changed');
    expect((await recalculate()).mealCount).toBe(0);
  });

  it('改冷藏期天数（不影响聚合）→ **不**标过期', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    await listOrFail();
    // 冷藏期只管推荐排除，不在聚合路径上——误标会让警告卡说一句解释不了的话
    // （这里直接改库：冷藏期的编辑入口不在 PATCH 的开放字段里，归 #26 收口）
    harness.db.prepare('UPDATE family_rules SET cool_off_days = 30 WHERE id = 1').run();
    const rules = await familyRulesRow();
    expect(rules.coolOffDays).toBe(30);
    expect((await listOrFail()).stale).toBe(false);
  });

  it('没有进行中的清单时改家规是空操作（不凭空造一张）', async () => {
    harness = createTestHarness();
    const patched = await patchRules({ leftoverUplift: 2 });
    expect(patched.status).toBe(200);
    expect(await list()).toBeNull();
  });

  it('越界的截止时刻拒收（400，且库里的值没变）', async () => {
    harness = createTestHarness();
    for (const bad of [24, -1, 7.5]) {
      const { status, body } = await harness.json<{ error?: string }>('/api/family-rules', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lunchCutoffHour: bad }),
      });
      expect(status, String(bad)).toBe(400);
      expect(body.error).toBe('invalid_request');
    }
    expect((await familyRulesRow()).lunchCutoffHour).toBe(14);
  });

  it('影响判据就在领域层一处（日后新增家规值时不会漏标）', () => {
    const base: FamilyRules = { coolOffDays: 14, lunchCutoffHour: 14, dinnerCutoffHour: 21, leftoverUplift: 1.5 };
    expect(familyRulesAffectGrocery(base, { ...base, leftoverUplift: 2 })).toBe(true);
    expect(familyRulesAffectGrocery(base, { ...base, lunchCutoffHour: 13 })).toBe(true);
    expect(familyRulesAffectGrocery(base, { ...base, dinnerCutoffHour: 20 })).toBe(true);
    expect(familyRulesAffectGrocery(base, { ...base, coolOffDays: 30 })).toBe(false);
    expect(familyRulesAffectGrocery(base, base)).toBe(false);
  });
});

describe('手工行与勾选（总纲 §2.7 的两种行）', () => {
  it('手工行可加、可勾、可删；重算保留（它不属于任何菜谱）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    await listOrFail();

    const added = await addManual('垃圾袋');
    const manual = added.items.find((item) => item.kind === 'manual');
    expect(manual).toMatchObject({ name: '垃圾袋', grams: null, ingredientId: null, checked: false, sources: [] });

    const checked = await patchItem(manual!.id, true);
    expect(checked.items.find((item) => item.id === manual!.id)?.checked).toBe(true);

    const recalculated = await recalculate();
    expect(recalculated.items.find((item) => item.id === manual!.id)?.checked).toBe(true);

    const deleted = await deleteItem(manual!.id);
    expect(deleted.items.some((item) => item.kind === 'manual')).toBe(false);
  });

  it('聚合行不能手工删（它由已定餐聚合而来，改餐后重算自然更新）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    const created = await listOrFail();
    const { status, body } = await harness.json<{ error?: string; itemId?: number }>(
      `/api/grocery/items/${itemOf(created, 'pork_ribs').id}`,
      { method: 'DELETE' },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('aggregate_item_not_deletable');
    expect(body.itemId).toBe(itemOf(created, 'pork_ribs').id);
  });

  it('手工行不走字典：同名的两次添加各自成行（掌勺者写什么就是什么）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    await listOrFail();
    await addManual('姜');
    const twice = await addManual('姜');
    const manual = twice.items.filter((item) => item.kind === 'manual');
    expect(manual.map((item) => item.name)).toEqual(['姜', '姜']);
    expect(manual[0]!.id).not.toBe(manual[1]!.id);
  });

  it('没有清单时加手工行会先物化一张（掌勺者要往清单里放东西，就该有清单接着）', async () => {
    harness = createTestHarness();
    const added = await addManual('盐');
    expect(added.mealCount).toBe(0);
    expect(added.items.map((item) => item.name)).toEqual(['盐']);
    expect((await list())?.id).toBe(added.id);
  });

  it('空名字/超长名字拒收（错误形状与其余路由一致）', async () => {
    harness = createTestHarness();
    const blank = await harness.json<{ error?: string; issues?: { message: string }[] }>('/api/grocery/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('invalid_request');
    const long = await harness.json('/api/grocery/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '好'.repeat(51) }),
    });
    expect(long.status).toBe(400);
  });

  it('勾选不存在/已归档的行：404（归档的清单不再接受改动）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    const created = await listOrFail();
    const itemId = itemOf(created, 'pork_ribs').id;
    await archive();
    const { status, body } = await harness.json<{ error?: string }>(`/api/grocery/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checked: true }),
    });
    expect(status).toBe(404);
    expect(body.error).toBe('grocery_item_not_found');
  });
});

describe('归档（总纲 §2.7：进行中 / 已归档）', () => {
  it('买完归档：状态变已归档、归档时间落库；再读页面没有进行中的清单，归档计数看得见', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    // 界面上的归档按钮长在清单上，所以这里也先读一次（读就是物化的时刻）
    await listOrFail();
    const archived = await archive();
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.items.length).toBeGreaterThan(0);

    const { body } = await harness.json<GroceryListResponse>('/api/grocery');
    expect(body.list).toBeNull();
    expect(body.archivedCount).toBe(1);

    // 归档之后定新餐 → 新的一轮清单（不是把归档那份改回来）
    await book('2025-06-03:lunch', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    const next = await listOrFail();
    expect(next.id).not.toBe(archived.id);
    expect(next.status).toBe('active');
    expect(next.items.some((item) => item.ingredientId === 'chicken_wings')).toBe(true);
  });

  it('没有进行中的清单时归档是 409（不是静默成功）', async () => {
    harness = createTestHarness();
    const archiveResponse = await harness.json<{ error?: string }>('/api/grocery/archive', { method: 'POST' });
    expect(archiveResponse.status).toBe(409);
    expect(archiveResponse.body.error).toBe('no_grocery_list');
    const recalculateResponse = await harness.json<{ error?: string }>('/api/grocery/recalculate', { method: 'POST' });
    expect(recalculateResponse.status).toBe(409);
    expect(recalculateResponse.body.error).toBe('no_grocery_list');
  });

  it('归档的清单不影响后续重算（重算只动进行中的那份）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    const beforeArchive = await listOrFail();
    const archived = await archive();
    expect(archived.id).toBe(beforeArchive.id);
    await book('2025-06-03:lunch', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    // 归档之后的第一份新清单由「读」物化，重算再作用于它
    await listOrFail();
    const recalculated = await recalculate();
    expect(recalculated.id).not.toBe(archived.id);
    // 归档那份原样封存
    const stored = harness.db.prepare('SELECT status, archived_at FROM grocery_lists WHERE id = ?').get(archived.id) as {
      status: string;
      archived_at: string | null;
    };
    expect(stored.status).toBe('archived');
    expect(stored.archived_at).toBe(archived.archivedAt);
  });
});

/** 过期清单上按「重算」 */
async function recalculate(): Promise<GroceryList> {
  const { status, body } = await harness.json<{ list?: GroceryList; error?: string }>('/api/grocery/recalculate', {
    method: 'POST',
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.list!;
}

/**
 * 物化实体在 schema 上钉死的不变量（总纲 §2.7）。
 *
 * 这两条 HTTP 层永远碰不到（领域代码自己不会违反），但它们是「物化实体」这个决定的骨头：
 *   * 只能有一份进行中清单 → 不存在「现在读哪一份」的歧义（没有可变的指针列飘走的机会）；
 *   * 过期必有原因 → 警告卡上那句「⚠️ （原因），清单过期了」总说得出话来。
 * 日后加新的写路（批量重算、从外部工具改清单…）时，这两条要仍然成立。
 */
describe('物化实体的形状不变量', () => {
  it('同时只能有一份进行中的清单（局部唯一索引钉死）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    await listOrFail();

    expect(() =>
      harness.db
        .prepare(
          `INSERT INTO grocery_lists (status, stale, stale_reason, stale_slot_id, created_at, recalculated_at, archived_at, meal_count)
           VALUES ('active', 0, NULL, NULL, '2025-06-01T10:00:00Z', '2025-06-01T10:00:00Z', NULL, 0)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('过期必有原因、未过期必无原因（说不清为什么过期的清单等于没有过期标记）', async () => {
    harness = createTestHarness();
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    const list = await listOrFail();
    const update = (stale: number, reason: string | null, slotId: string | null = null): void => {
      harness.db
        .prepare('UPDATE grocery_lists SET stale = ?, stale_reason = ?, stale_slot_id = ? WHERE id = ?')
        .run(stale, reason, slotId, list.id);
    };
    // 过期 ⟺ 有原因；未过期不能带原因
    expect(() => update(1, null)).toThrow(/CHECK/);
    expect(() => update(0, 'menu_changed')).toThrow(/CHECK/);
    // 槽位那一半成对（#23 评审修复 ②）：槽位类原因必须带槽，家规改动必须不带
    expect(() => update(1, 'menu_changed', null)).toThrow(/CHECK/);
    expect(() => update(1, 'menu_changed', '2025-06-02:lunch')).not.toThrow();
    expect(() => update(1, 'family_rules_changed', '2025-06-02:lunch')).toThrow(/CHECK/);
    expect(() => update(1, 'family_rules_changed')).not.toThrow();
    // 原因值域封闭：枚举以外的串进不了库（渲染好的中文正是这么被挡在外面的）
    expect(() => update(1, '今天午餐的菜单变了')).toThrow(/CHECK/);
  });
});

async function archive(): Promise<GroceryList> {
  const { status, body } = await harness.json<{ list?: GroceryList; error?: string }>('/api/grocery/archive', {
    method: 'POST',
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.list!;
}

async function addManual(name: string): Promise<GroceryList> {
  const { status, body } = await harness.json<{ list?: GroceryList; error?: string; issues?: unknown }>(
    '/api/grocery/items',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) },
  );
  expect(status, JSON.stringify(body)).toBe(200);
  return body.list!;
}

async function patchItem(itemId: number, checked: boolean): Promise<GroceryList> {
  const { status, body } = await harness.json<{ list?: GroceryList; error?: string }>(
    `/api/grocery/items/${itemId}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checked }) },
  );
  expect(status, JSON.stringify(body)).toBe(200);
  return body.list!;
}

async function deleteItem(itemId: number): Promise<GroceryList> {
  const { status, body } = await harness.json<{ list?: GroceryList; error?: string }>(
    `/api/grocery/items/${itemId}`,
    { method: 'DELETE' },
  );
  expect(status, JSON.stringify(body)).toBe(200);
  return body.list!;
}
