import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import type {
  FamilyRulesResponse,
  MealEvent as EventJson,
  MealSlot as SlotJson,
  MenuPortion,
  PortionRulesResponse,
  SlotsResponse,
  SlotResponse,
} from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 留量（#22、总纲 §2.6、§3 决议 4）：晚餐预定成「吃剩的」→ 引用同日午餐 → 午餐的单道菜标记留量、
 * 买菜量按系数（默认 1.5×）上浮 → 取消被引用的午餐时引用方自动退回未定（事件留痕）。
 *
 * 本文件守的那条**不变量**是总纲 §2.6 的黑体句：
 *
 *     上浮生效条件 = 留量标记 **∧** 有效引用存在
 *
 * 四个组合（标记有无 × 引用有无）逐条断言：单看标记就上浮会让没人吃剩菜的一餐白白多做 50%，
 * 单看引用就上浮则是对没标「多做」的菜凭空加量——两个方向都是错的，且都只能靠行为测出来。
 *
 * 与其余 API 测试同口径：只断言**外部可见行为**（HTTP 响应形状与数字），不查表结构。
 */

const ALL = ['mom', 'dad', 'dabao', 'xiaobao'];

async function book(id: string, payload: unknown) {
  return await harness.json<{
    slot?: SlotJson;
    error?: string;
    id?: string;
    referencedId?: string;
    issues?: { path: string; message: string }[];
  }>(`/api/slots/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function cancel(id: string) {
  return await harness.json<{ ok?: boolean; released?: string[]; error?: string }>(`/api/slots/${id}`, {
    method: 'DELETE',
  });
}

async function getSlot(id: string): Promise<{ slot: SlotJson; history: EventJson[] }> {
  const { status, body } = await harness.json<SlotResponse>(`/api/slots/${id}`);
  expect(status).toBe(200);
  return body;
}

/** 服务端算的份量（编辑器/大卡读到的必须与它一致：算的规则只有一份） */
async function preview(
  diners: string[],
  dishes: { recipeId: string; keepLeftover?: boolean }[],
  slotId?: string,
): Promise<MenuPortion> {
  const { status, body } = await harness.json<{ portion: MenuPortion; error?: string }>('/api/portion/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ diners, dishes, slotId }),
  });
  expect(status).toBe(200);
  return body.portion;
}

function dishOf(portion: MenuPortion, recipeId: string) {
  const dish = portion.dishes.find((item) => item.recipeId === recipeId);
  if (!dish) throw new Error(`没有这道菜：${recipeId}`);
  return dish;
}

/** 猪排骨的克数（红烧排骨的主料，成人份基准 150 g——最容易一眼看出倍数的那个数） */
function ribsGrams(portion: MenuPortion): number {
  const ingredient = dishOf(portion, 'hongshaopaigu').ingredients.find((item) => item.ingredientId === 'pork_ribs');
  if (!ingredient) throw new Error('红烧排骨里没有猪排骨');
  return ingredient.grams;
}

/**
 * 定一餐午餐，至少一道菜标留量（默认红烧排骨留量 + 一道素菜不留）。
 * 午餐在测试的注入时钟下必须是「还没过」的：起点 2025-06-01T10:00Z = 家庭时区 18:00，
 * 午餐（14:00 截止）已经过了，所以引用场景一律用**明天**（06-02）。
 */
async function bookLunch(id = '2025-06-02:lunch', keep = true) {
  const { status, body } = await book(id, {
    diners: ALL,
    dishes: [
      { recipeId: 'hongshaopaigu', keepLeftover: keep },
      { recipeId: 'suanrongcaixin' },
    ],
  });
  expect(status).toBe(200);
  return body.slot!;
}

/** 把晚餐预定成「吃中午剩的」 */
async function bookLeftoverDinner(id = '2025-06-02:dinner', leftoverOf = '2025-06-02:lunch') {
  return await book(id, { diners: ALL, dishes: [], leftoverOf });
}

describe('「吃剩的」预定', () => {
  it('晚餐可以预定成吃中午剩的：没有自己的菜品快照，菜从午餐的留量菜现推导', async () => {
    harness = createTestHarness();
    await bookLunch();

    const { status, body } = await bookLeftoverDinner();
    expect(status).toBe(200);
    expect(body.slot?.status).toBe('decided');
    expect(body.slot?.menu?.leftoverSlotId).toBe('2025-06-02:lunch');
    // 吃的就是午餐标了留量的那一道（蒜蓉菜心没标留量，不在里面）
    expect(body.slot?.menu?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨']);
    expect(body.slot?.menu?.dishes[0]?.keepLeftover).toBe(true);

    // 落库的只有一条事件、且它不带菜品快照——「这一餐吃什么」是推导出来的，不是另存的一份
    const { history } = await getSlot('2025-06-02:dinner');
    expect(history.map((event) => event.type)).toEqual(['decide']);
    expect(history[0]?.leftoverSlotId).toBe('2025-06-02:lunch');
    expect(history[0]?.dishes).toEqual([]);
  });

  it('午餐改了菜，晚餐跟着变（菜单是推导的，不是定餐那一刻冻住的快照）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();
    expect((await getSlot('2025-06-02:dinner')).slot.menu?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨']);

    // 改午餐：多标一道素菜留量
    const { status } = await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }, { recipeId: 'suanrongcaixin', keepLeftover: true }],
    });
    expect(status).toBe(200);

    expect((await getSlot('2025-06-02:dinner')).slot.menu?.dishes.map((dish) => dish.name)).toEqual([
      '红烧排骨',
      '蒜蓉菜心',
    ]);
  });

  it('「吃剩的」形态与自带菜单互斥（两份菜单就会有两个说了算的答案）', async () => {
    harness = createTestHarness();
    await bookLunch();

    const { status, body } = await book('2025-06-02:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      leftoverOf: '2025-06-02:lunch',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    // 拒绝就是拒绝：不该在历史里留下半条
    expect((await getSlot('2025-06-02:dinner')).history).toEqual([]);
  });

  it('引用必须指得着东西：只接受同日午餐，午餐得已定且至少一道标了留量', async () => {
    harness = createTestHarness();

    // 午餐还没定 → 拒绝
    const notYet = await bookLeftoverDinner();
    expect(notYet.status).toBe(400);
    expect(notYet.body.error).toBe('invalid_leftover_reference');

    // 引用昨天的午餐 / 引用晚餐自己：跨日与自引用都没有语义
    await bookLunch();
    for (const bad of ['2025-06-01:lunch', '2025-06-02:dinner', '2025-06-02:breakfast', '瞎写的']) {
      const { status, body } = await bookLeftoverDinner('2025-06-02:dinner', bad);
      expect(status, bad).toBe(400);
      expect(body.error, bad).toBe('invalid_leftover_reference');
    }

    // 午餐一道留量菜都没标 → 没有可吃剩的，同样是拒绝（不是「空菜单也算吃剩的」）
    const { status: plainStatus } = await book('2025-06-03:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
    });
    expect(plainStatus).toBe(200);
    const nothing = await bookLeftoverDinner('2025-06-03:dinner', '2025-06-03:lunch');
    expect(nothing.status).toBe(400);
    expect(nothing.body.error).toBe('nothing_to_reheat');
    expect(nothing.body.referencedId).toBe('2025-06-03:lunch');
  });

  it('被取消过的午餐不能再被引用（引用要的是当前有效的菜单）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await cancel('2025-06-02:lunch');

    const { status, body } = await bookLeftoverDinner();
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_leftover_reference');
  });

  it('相同内容重复提交不追事件，但「引用」与「普通菜单」是两个不同的状态', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();
    await bookLeftoverDinner();
    expect((await getSlot('2025-06-02:dinner')).history.length).toBe(1);

    // 改成自带菜单（去掉引用）会追一条：留痕要能看出这一餐是怎么来的
    await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    const { slot, history } = await getSlot('2025-06-02:dinner');
    expect(history.map((event) => event.type)).toEqual(['decide', 'replace']);
    expect(slot.menu?.leftoverSlotId).toBeNull();
    expect(slot.menu?.dishes.map((dish) => dish.name)).toEqual(['番茄炒蛋']);
  });

  it('午餐（没有可引用的上一餐）不吃剩的：只接受同日午餐，午餐本身没有这个形态', async () => {
    harness = createTestHarness();
    await bookLunch();

    // 午餐引用自己 → 拒绝（语义上「中午吃中午剩的」是句空话）
    const { status, body } = await book('2025-06-02:lunch', { diners: ALL, dishes: [], leftoverOf: '2025-06-02:lunch' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_leftover_reference');
  });
});

/**
 * 不变量（总纲 §2.6）：**上浮生效 = 留量标记 ∧ 有效引用**。
 * 四个组合逐条断言——这是本票唯一必须守死的算术。
 */
describe('留量上浮的不变量：标记 ∧ 引用', () => {
  it('标记 ∧ 引用 → 上浮（默认 1.5×）；大人名单下 150 × 2 × 1.5 = 450 是可复算的', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    const portion = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }], '2025-06-02:lunch');
    expect(dishOf(portion, 'hongshaopaigu').uplift).toBe(1.5);
    expect(portion.uplift).toBe(1.5);
    expect(ribsGrams(portion)).toBe(450);
  });

  it('只有标记、没有引用 → 不上浮（没人吃剩菜的一餐不该白白多做 50%）', async () => {
    harness = createTestHarness();
    await bookLunch();
    // 没有任何「吃剩的」引用
    const portion = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }], '2025-06-02:lunch');
    expect(dishOf(portion, 'hongshaopaigu').uplift).toBe(1);
    expect(portion.uplift).toBe(1);
    expect(ribsGrams(portion)).toBe(300);
  });

  it('只有引用、没有标记 → 不上浮（凭空给没标「多做」的菜加量是另一个方向的错）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    const portion = await preview(
      ['mom', 'dad'],
      [{ recipeId: 'suanrongcaixin', keepLeftover: false }],
      '2025-06-02:lunch',
    );
    expect(dishOf(portion, 'suanrongcaixin').uplift).toBe(1);
    expect(portion.uplift).toBe(1);
  });

  it('既没标记也没引用 → 恒 1（普通的一餐）', async () => {
    harness = createTestHarness();
    const portion = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu' }]);
    expect(dishOf(portion, 'hongshaopaigu').uplift).toBe(1);
    expect(portion.uplift).toBe(1);
    expect(ribsGrams(portion)).toBe(300);
  });

  it('引用失效后上浮一起失效（取消午餐 → 晚餐退回未定 → 午餐的读数回到不上浮）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    // 生效中：午餐的红烧排骨按 1.5 上浮（两个成人 150 × 2 × 1.5 = 450）
    const active = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }], '2025-06-02:lunch');
    expect(active.uplift).toBe(1.5);
    expect(ribsGrams(active)).toBe(450);

    // 取消午餐（联动把晚餐也退回未定）→ 引用没了、上浮也跟着没了
    await cancel('2025-06-02:lunch');
    const gone = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }], '2025-06-02:lunch');
    expect(gone.uplift).toBe(1);
    expect(ribsGrams(gone)).toBe(300);
  });

  it('引用方的读数也上浮（晚餐端的正是多做的那几道），且只对被引用那一餐的留量菜上浮', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    // 晚餐吃的就是上浮后的量：150 × Σ系数 × 1.5（晚餐名单是全员，Σ = 3.164）
    const dinner = (await harness.json<SlotResponse>('/api/slots/2025-06-02:dinner')).body.slot.portion!;
    expect(dinner.uplift).toBe(1.5);
    expect(ribsGrams(dinner)).toBe(Math.round(150 * dinner.factorSum * 1.5 + 1e-9));
    // 同一道菜、同一个时刻：晚餐与午餐算出来的是同一个数（两边读同一份算术）

    // 午餐里没标留量的那道素菜照旧不上浮（上浮是单道级的，总纲 §2.6）
    const lunch = (await harness.json<SlotResponse>('/api/slots/2025-06-02:lunch')).body.slot.portion!;
    expect(dishOf(lunch, 'suanrongcaixin').uplift).toBe(1);
    expect(dishOf(lunch, 'hongshaopaigu').uplift).toBe(1.5);
  });

  it('餐槽列表与单餐接口都报实际生效的倍数（首屏与编辑器读同一份算术）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    const { status, body } = await harness.json<SlotsResponse>('/api/slots?days=2');
    expect(status).toBe(200);
    const lunch = body.slots.find((slot) => slot.id === '2025-06-02:lunch')!;
    const dinner = body.slots.find((slot) => slot.id === '2025-06-02:dinner')!;
    expect(lunch.portion?.uplift).toBe(1.5);
    expect(dinner.portion?.uplift).toBe(1.5);
    expect(dinner.menu?.leftoverSlotId).toBe('2025-06-02:lunch');
  });
});

/**
 * `slotId` 是**餐槽上下文**，不是一个可有可无的过滤器：传了它就必须是个真餐槽 id。
 *
 * 非法 id 静默退化成「无引用」是最坏的一种失败——调用方既不报错也不上浮，拿到的是一份
 * 看起来正常、其实少算了一个系数的读数。所以宁可 400（`invalid_slot_id`，与餐槽路由同形状）。
 */
describe('份量预览的 slotId 必须是真餐槽', () => {
  it('非法 slotId 明确报错，而不是静默按「无引用」算', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    // 格式不对 / 不存在的日期 / 早餐（不进模型）——都不是餐槽
    for (const bad of ['junk', '2025-06-02', '2025-06-02:breakfast', '2025-02-31:lunch']) {
      const { status, body } = await harness.json<{ error?: string; id?: string }>('/api/portion/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          diners: ['mom', 'dad'],
          dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }],
          slotId: bad,
        }),
      });
      expect(status, bad).toBe(400);
      expect(body.error, bad).toBe('invalid_slot_id');
      // 错误要指认得着那个坏 id，界面才能说清是哪一条地址不对
      expect(body.id, bad).toBe(bad);
    }
  });

  it('正常路径不受影响：合法 slotId 照常上浮，不传 slotId 仍是草稿（无引用）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    const withSlot = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }], '2025-06-02:lunch');
    expect(withSlot.uplift).toBe(1.5);

    const draft = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }]);
    expect(draft.uplift).toBe(1);
  });

  it('还没定过餐的餐槽照常预览（编辑器开一张新餐槽走的就是这条路）：合法 id、无引用、不上浮', async () => {
    harness = createTestHarness();

    // 不是「不存在就报错」：**没定过**（一张还没开过的新餐槽）与**id 不是餐槽**是两回事。
    // 前者是编辑器的最常见入口，必须照常返回；只有后者才是「你说的这一餐我听不懂」。
    const fresh = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }], '2025-06-02:lunch');
    expect(fresh.uplift).toBe(1);
    expect(ribsGrams(fresh)).toBe(300);
  });
});

/**
 * 家规化（台账「归属 #22」第一条）：系数进家规表、可由掌勺者调整。
 * 断言「改了家规，份量真的跟着变」——配置值躺在表里不生效是最坏的一种完成。
 */
describe('留量上浮系数是家规（可配）', () => {
  it('默认 1.5×，且份量规则表读得到它（界面显示倍数从这一处来）', async () => {
    harness = createTestHarness();

    const rules = await harness.json<FamilyRulesResponse>('/api/family-rules');
    expect(rules.status).toBe(200);
    expect(rules.body.rules.leftoverUplift).toBe(1.5);

    const portionRules = await harness.json<PortionRulesResponse>('/api/portion/rules');
    expect(portionRules.body.rules.uplift).toBe(1.5);
  });

  it('改家规之后上浮按新系数算（2×），且改的是配置、不是某一份菜单', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    const patched = await harness.json<FamilyRulesResponse>('/api/family-rules', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leftoverUplift: 2 }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.rules.leftoverUplift).toBe(2);

    const portion = await preview(['mom', 'dad'], [{ recipeId: 'hongshaopaigu', keepLeftover: true }], '2025-06-02:lunch');
    expect(dishOf(portion, 'hongshaopaigu').uplift).toBe(2);
    expect(ribsGrams(portion)).toBe(600); // 150 × 2 × 2
  });

  it('越界的系数被拒（zod 与领域层各一道），拒了就不改库', async () => {
    harness = createTestHarness();

    for (const bad of [0.5, 0, -1, 6, 100]) {
      const { status } = await harness.json<FamilyRulesResponse>('/api/family-rules', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leftoverUplift: bad }),
      });
      expect(status, String(bad)).toBe(400);
    }
    // 一次都没改进去
    const rules = await harness.json<FamilyRulesResponse>('/api/family-rules');
    expect(rules.body.rules.leftoverUplift).toBe(1.5);
  });
});

/**
 * 取消联动（总纲 §3 决议 4）：取消被「吃剩的」引用的午餐 → 引用方晚餐槽自动退回未定 + 留痕。
 */
describe('取消被引用的午餐：引用方自动退回未定', () => {
  it('取消午餐 → 晚餐退回未定，取消响应里报出被退回的槽，两条取消事件都在留痕里', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    const { status, body } = await cancel('2025-06-02:lunch');
    expect(status).toBe(200);
    expect(body.released).toEqual(['2025-06-02:dinner']);

    // 引用方退回未定：没有菜单、没有份量，但留痕里留着「它曾经被预定成吃剩的」
    const dinner = await getSlot('2025-06-02:dinner');
    expect(dinner.slot.status).toBe('undecided');
    expect(dinner.slot.menu).toBeNull();
    expect(dinner.history.map((event) => event.type)).toEqual(['decide', 'cancel']);
    expect(dinner.history[0]?.leftoverSlotId).toBe('2025-06-02:lunch');
    // 联动的那条取消事件也交代得清「是引用没了」——被取消的那一餐指向它
    expect(dinner.history[1]?.leftoverSlotId).toBeNull();

    // 午餐自己那条事件的菜单仍能读出来（append-only：历史不删）
    const lunch = await getSlot('2025-06-02:lunch');
    expect(lunch.slot.status).toBe('undecided');
    expect(lunch.history[0]?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨', '蒜蓉菜心']);
  });

  it('没有被引用的餐取消时不动别人（released 为空）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });

    const { status, body } = await cancel('2025-06-02:lunch');
    expect(status).toBe(200);
    expect(body.released).toEqual([]);
    expect((await getSlot('2025-06-02:dinner')).slot.status).toBe('decided');
    expect((await getSlot('2025-06-02:dinner')).history.length).toBe(1);
  });

  it('引用早被改餐改掉的晚餐不会被误伤（只看每个槽的最后一条事件）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();
    // 晚餐改成自带菜单：引用没了
    await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });

    const { body } = await cancel('2025-06-02:lunch');
    expect(body.released).toEqual([]);
    expect((await getSlot('2025-06-02:dinner')).slot.status).toBe('decided');
  });

  it('改午餐把留量标记全拆了 → 引用失效、晚餐同样退回未定（不能停在「已定 + 零道菜」）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    // 把留量标记去掉
    const { status } = await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'suanrongcaixin' }],
    });
    expect(status).toBe(200);

    const dinner = await getSlot('2025-06-02:dinner');
    expect(dinner.slot.status).toBe('undecided');
    expect(dinner.slot.menu).toBeNull();
    expect(dinner.history.map((event) => event.type)).toEqual(['decide', 'cancel']);
  });

  it('午餐还留着别的留量菜时，晚餐只是跟着变、不退（引用仍然有效）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    // 把红烧排骨的留量去掉，但给素菜标上留量
    await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'suanrongcaixin', keepLeftover: true }],
    });

    const dinner = await getSlot('2025-06-02:dinner');
    expect(dinner.slot.status).toBe('decided');
    expect(dinner.slot.menu?.dishes.map((dish) => dish.name)).toEqual(['蒜蓉菜心']);
  });

  it('联动退回之后还能重新定成「吃剩的」（取消不是封禁）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();
    await cancel('2025-06-02:lunch');

    // 午餐重新定（仍带留量），晚餐也能重新引用
    await bookLunch();
    const { status } = await bookLeftoverDinner();
    expect(status).toBe(200);
    expect((await getSlot('2025-06-02:dinner')).slot.menu?.leftoverSlotId).toBe('2025-06-02:lunch');
  });
});

/**
 * 「吃剩的」入口的可用性由服务端推导（前端不必也不该自己猜：它连今天午餐定没定都不一定看得见）。
 */
describe('餐槽回传「吃剩的」入口的可用性', () => {
  it('午餐定下留量菜后晚餐才有入口；没定 / 没留量 / 是午餐自己 → 都没有', async () => {
    harness = createTestHarness();

    // 午餐还没定：晚餐没有可吃剩的
    const before = await getSlot('2025-06-02:dinner');
    expect(before.slot.leftoverSource).toBeNull();
    // 午餐自己永远没有这个入口
    expect((await getSlot('2025-06-02:lunch')).slot.leftoverSource).toBeNull();

    // 定下但没标留量：还是没有
    await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    expect((await getSlot('2025-06-02:dinner')).slot.leftoverSource).toBeNull();

    // 标了留量：入口出现，带上可吃的菜
    await bookLunch();
    const source = (await getSlot('2025-06-02:dinner')).slot.leftoverSource;
    expect(source?.slotId).toBe('2025-06-02:lunch');
    expect(source?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨']);

    // 午餐被取消：入口消失
    await cancel('2025-06-02:lunch');
    expect((await getSlot('2025-06-02:dinner')).slot.leftoverSource).toBeNull();
  });

  it('餐槽列表也带这个入口（首屏那张大卡要能直接点）', async () => {
    harness = createTestHarness();
    await bookLunch();

    const { body } = await harness.json<SlotsResponse>('/api/slots?days=2');
    const dinner = body.slots.find((slot) => slot.id === '2025-06-02:dinner')!;
    expect(dinner.leftoverSource?.slotId).toBe('2025-06-02:lunch');
    const lunch = body.slots.find((slot) => slot.id === '2025-06-02:lunch')!;
    expect(lunch.leftoverSource).toBeNull();
  });
});

/**
 * 时钟注入：留量引用是**按时钟走的**——引用的是「同日午餐」，跨天就什么也引用不到。
 * （上浮本身不看时刻，只看当前引用；这条测的是日期这条边界。）
 */
describe('留量引用的日期边界（注入时钟）', () => {
  it('今天引用不了昨天的午餐（跨日的「中午剩的」没有语义）', async () => {
    harness = createTestHarness();

    // 06-01 上午定下午餐、标留量
    harness.clock.set('2025-06-01T02:00:00.000Z'); // 家庭时区 10:00
    await book('2025-06-01:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }],
    });

    // 到了 06-02：昨天的午餐还在库里、也有留量，但 06-02 的晚餐只认「同日午餐」
    harness.clock.set('2025-06-02T02:00:00.000Z'); // 家庭时区 10:00
    expect((await getSlot('2025-06-02:dinner')).slot.leftoverSource).toBeNull();

    const { status, body } = await bookLeftoverDinner('2025-06-02:dinner', '2025-06-01:lunch');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_leftover_reference');
  });

  it('晚餐过了截止时刻就不能再预定成「吃剩的」（与普通定餐同一道门）', async () => {
    harness = createTestHarness();
    harness.clock.set('2025-06-01T02:00:00.000Z'); // 家庭时区 10:00
    await book('2025-06-01:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }],
    });

    harness.clock.set('2025-06-01T14:00:00.000Z'); // 家庭时区 22:00，晚餐也过了
    const { status, body } = await bookLeftoverDinner('2025-06-01:dinner', '2025-06-01:lunch');
    expect(status).toBe(400);
    expect(body.error).toBe('slot_passed');
  });

  it('撤掉留量标记后当日之内还能改回来（引用跟着当前状态走，不留下不可逆的痕迹）', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    await book('2025-06-02:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'suanrongcaixin' }],
    });
    expect((await getSlot('2025-06-02:dinner')).slot.status).toBe('undecided');

    // 标回留量：晚餐重新预定成吃剩的（这时它是未定的，重新定就是了）
    await bookLunch();
    const { status } = await bookLeftoverDinner();
    expect(status).toBe(200);
    expect((await getSlot('2025-06-02:dinner')).slot.menu?.leftoverSlotId).toBe('2025-06-02:lunch');
  });
});

/**
 * 撤销「换一整套」与「吃剩的」的交界（可达路径，不是手改库的臆想）：
 *
 *   dinner 定成吃剩的 → 换成一整套推荐（引用没了）→ 午餐被取消 → 这时撤销。
 *
 * 上一套是一个**已经指不着东西**的引用（它的菜就是「多做的那几道」，现在不存在了），而「吃剩的」
 * 事件不带菜品快照，恢复不出一份菜单——所以拒绝撤销（`nothing_to_undo`）而不是写一条悬空引用。
 * （读侧把悬空引用当未定读作为兼底，但那条路不该被写出来。）
 */
describe('撤销换套时上一套的引用已经失效', () => {
  it('上一套是「吃剩的」而被引用那一餐已取消 → 撤不回去（409），不写悬空引用', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();

    // 晚上换成一整套（源标 recommendation → replace_set + recommendation，可撤销），引用跟着没了
    const replaced = await book('2025-06-02:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      source: 'recommendation',
    });
    expect(replaced.status).toBe(200);
    expect((await getSlot('2025-06-02:dinner')).slot.canUndoSet).toBe(true);

    // 午餐被取消；晚餐的当前事件已经不带引用了，所以不会被联动画回
    await cancel('2025-06-02:lunch');
    expect((await getSlot('2025-06-02:dinner')).slot.status).toBe('decided');

    // 这时撤销：上一条事件是「吃剩的」引用，但那一餐已经不在了
    const undone = await harness.json<{ slot?: SlotJson; error?: string; id?: string }>(
      '/api/slots/2025-06-02:dinner/undo-set',
      { method: 'POST' },
    );
    expect(undone.status).toBe(409);
    expect(undone.body.error).toBe('nothing_to_undo');

    // 晚餐还在换套之后的那一套上（没被改成一个悬空引用），也没有多出一条事件
    const dinner = await getSlot('2025-06-02:dinner');
    expect(dinner.slot.menu?.leftoverSlotId).toBeNull();
    expect(dinner.slot.menu?.dishes.map((dish) => dish.name)).toEqual(['番茄炒蛋']);
    expect(dinner.history.map((event) => event.type)).toEqual(['decide', 'replace_set']);
  });

  it('上一套是「吃剩的」且引用仍然有效 → 照常撤销得回去', async () => {
    harness = createTestHarness();
    await bookLunch();
    await bookLeftoverDinner();
    await book('2025-06-02:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      source: 'recommendation',
    });

    const { status, body } = await harness.json<{ slot?: SlotJson; error?: string }>(
      '/api/slots/2025-06-02:dinner/undo-set',
      { method: 'POST' },
    );
    expect(status).toBe(200);
    expect(body.slot?.menu?.leftoverSlotId).toBe('2025-06-02:lunch');
    expect(body.slot?.menu?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨']);
  });
});
