import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { CANDIDATE_PROMPT_VERSION, PROMPT_VERSION } from '../llm/prompt.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

// 线上形状从 wire-types 取（与前端同一处定义），不手抄
import type { MealEvent as EventJson, MealSlot as SlotJson, SlotsResponse } from '../wire-types.js';

/** 家庭时区是 Asia/Shanghai：测试的「现在」都按它写，避免断言随 runner 时区漂移 */
function shanghai(iso: string): string {
  return iso;
}

async function listSlots(days = 3): Promise<SlotsResponse> {
  const { status, body } = await harness.json<SlotsResponse>(`/api/slots?days=${days}`);
  expect(status).toBe(200);
  return body;
}

async function getSlot(id: string): Promise<{ slot: SlotJson; history: EventJson[] }> {
  const { status, body } = await harness.json<{ slot: SlotJson; history: EventJson[] }>(`/api/slots/${id}`);
  expect(status).toBe(200);
  return body;
}

async function book(id: string, payload: unknown) {
  return await harness.json<{ slot?: SlotJson; error?: string; recipeId?: string; memberId?: string }>(
    `/api/slots/${id}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

async function cancel(id: string) {
  return await harness.json<{ ok?: boolean; error?: string }>(`/api/slots/${id}`, { method: 'DELETE' });
}

/** 撤销换一整套（#18）：无请求体，成功返回整个 slot */
async function undoSet(id: string) {
  return await harness.json<{ slot?: SlotJson; error?: string; id?: string }>(`/api/slots/${id}/undo-set`, {
    method: 'POST',
  });
}

const DINNERS = ['hongshaopaigu', 'suanrongcaixin', 'dongguapaigutang'];
const ALL = ['mom', 'dad', 'dabao', 'xiaobao'];

/**
 * 餐槽与手动定餐（总纲 §2.1、§3）：日期 × 午/晚，未定 / 已定；菜单 = 用餐者名单快照 + 菜品。
 * 本票先把「手动」这条路走通（不靠推荐）：定一餐、改菜、取消。
 */
describe('餐槽列表', () => {
  it('从今天起逐日排午/晚，默认全是未定', async () => {
    harness = createTestHarness();

    const { today, slots } = await listSlots(3);
    // 注入时钟的 2025-06-01T10:00Z 在家庭时区（+8）是当天 18:00：午餐已过，只列今晚与往后
    expect(today).toBe('2025-06-01');

    expect(slots.map((slot) => slot.id)).toEqual([
      '2025-06-01:dinner',
      '2025-06-02:lunch',
      '2025-06-02:dinner',
      '2025-06-03:lunch',
      '2025-06-03:dinner',
    ]);
    expect(slots.every((slot) => slot.status === 'undecided')).toBe(true);
    expect(slots.every((slot) => slot.menu === null)).toBe(true);
  });

  it('已过截止时刻的餐次不列（午餐 14:00 之后就不是「下一餐」的候选）', async () => {
    harness = createTestHarness();

    // 早上 7 点（家庭时区）：今天午晚都在
    harness.clock.set(shanghai('2025-06-01T23:00:00.000Z'));
    expect((await listSlots(1)).slots.map((slot) => slot.id)).toEqual(['2025-06-02:lunch', '2025-06-02:dinner']);

    // 下午 3 点：今天的午餐已过
    harness.clock.set('2025-06-02T07:00:00.000Z');
    expect((await listSlots(1)).slots.map((slot) => slot.id)).toEqual(['2025-06-02:dinner']);

    // 晚上 10 点：今天的午晚都过了
    harness.clock.set('2025-06-02T14:00:00.000Z');
    expect((await listSlots(1)).slots.map((slot) => slot.id)).toEqual(['2025-06-03:lunch', '2025-06-03:dinner']);  });

  it('截止时刻按家庭时区算，与 runner 的本地时区无关', async () => {
    harness = createTestHarness();
    // 家庭时区 2025-06-02 13:59（午餐还差一分钟）→ 今天的午餐还在列
    harness.clock.set('2025-06-02T05:59:00.000Z');
    expect((await listSlots(1)).slots.map((slot) => slot.id)).toContain('2025-06-02:lunch');

    // 14:00 整 → 过点（截止是「过了这个点」而不是「过了这一分」）
    harness.clock.set('2025-06-02T06:00:00.000Z');
    expect((await listSlots(1)).slots.map((slot) => slot.id)).not.toContain('2025-06-02:lunch');
  });
});

/**
 * 手动定餐（总纲 §2.1「定餐 = 换菜，同一编辑器」）：整份菜单一次性提交，
 * 未定 → 第一条记「预定」，已定 → 后续每条记「改餐」。
 */
describe('手动定餐', () => {
  it('定一餐：菜单带用餐者快照与菜品，状态从未定变已定', async () => {
    harness = createTestHarness();

    const { status, body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: DINNERS.map((recipeId) => ({ recipeId })),
    });
    expect(status).toBe(200);
    expect(body.slot?.status).toBe('decided');
    expect(body.slot?.menu?.diners.map((diner) => diner.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝']);
    expect(body.slot?.menu?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨', '蒜蓉菜心', '冬瓜排骨汤']);
    expect(body.slot?.menu?.dishes.map((dish) => dish.kind)).toEqual(['meat', 'veg', 'soup_meat']);

    // 列表里反映得出来
    const listed = (await listSlots(1)).slots.find((slot) => slot.id === '2025-06-01:dinner');
    expect(listed?.status).toBe('decided');
  });

  it('用餐者名单是快照：改临时名单不影响别的餐，家人改名的旧事件也不改写', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', { diners: ['mom', 'dabao'], dishes: [{ recipeId: 'fanqiechaodan' }] });
    const { slot } = await getSlot('2025-06-01:dinner');
    expect(slot.menu?.diners.map((diner) => diner.memberId)).toEqual(['mom', 'dabao']);

    // 家人改名后：历史事件里存的还是当时的名字（快照的意义）
    harness.db.prepare("UPDATE members SET name = '麻麻' WHERE id = 'mom'").run();
    const after = await getSlot('2025-06-01:dinner');
    expect(after.slot.menu?.diners.map((diner) => diner.name)).toEqual(['妈妈', '大宝']);
  });

  it('定餐时可标记留量（单道级多做）', async () => {
    harness = createTestHarness();

    const { body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [
        { recipeId: 'hongshaopaigu', keepLeftover: true },
        { recipeId: 'suanrongcaixin' },
      ],
    });
    expect(body.slot?.menu?.dishes.map((dish) => dish.keepLeftover)).toEqual([true, false]);
  });

  it('已定的餐再提交就是改餐：历史里两条事件，当前状态是后一条', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'kelejichi' }, { recipeId: 'culutudousi' }],
    });

    const { slot, history } = await getSlot('2025-06-01:dinner');
    expect(history.map((event) => event.type)).toEqual(['decide', 'replace']);
    expect(slot.menu?.dishes.map((dish) => dish.name)).toEqual(['可乐鸡翅', '醋溜土豆丝']);
    // 第一条事件还在：历史不是被覆盖，而是被追加上去的
    expect(history[0]?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨', '蒜蓉菜心', '冬瓜排骨汤']);
  });

  it('内容与当前状态完全一样时不追事件（手机双击保存不该多两条一样的记录）', async () => {
    harness = createTestHarness();

    const booking = { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) };
    await book('2025-06-01:dinner', booking);
    await book('2025-06-01:dinner', booking);

    expect((await getSlot('2025-06-01:dinner')).history.length).toBe(1);
    // 但真的改了点什么（哪怕只是留量标记）就要留痕
    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }, { recipeId: 'suanrongcaixin' }, { recipeId: 'dongguapaigutang' }],
    });
    expect((await getSlot('2025-06-01:dinner')).history.length).toBe(2);
  });

  it('已过截止时刻的餐不能再定（服务端按注入时钟判定，不信客户端）', async () => {
    harness = createTestHarness();

    const { status, body } = await book('2025-06-01:lunch', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    expect(status).toBe(400);
    expect(body.error).toBe('slot_passed');

    // 明天的午餐没问题
    const tomorrow = await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    expect(tomorrow.status).toBe(200);
  });

  it('餐槽 id 格式不对返回 400，而不是把它当不存在', async () => {
    harness = createTestHarness();

    for (const bad of ['2025-06-01', '2025-06-01:breakfast', 'junk']) {
      const { status, body } = await book(bad, { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
      expect(status, bad).toBe(400);
      expect(body.error, bad).toBe('invalid_slot_id');
    }
    // 2025-02-31 是格式对但不存在的一天
    const { status, body } = await book('2025-02-31:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_slot_id');
  });

  it('菜单必须至少一道菜、用人者至少一人（空菜单/空名单没有意义）', async () => {
    harness = createTestHarness();

    const noDish = await book('2025-06-01:dinner', { diners: ALL, dishes: [] });
    expect(noDish.status).toBe(400);

    const noDiner = await book('2025-06-01:dinner', { diners: [], dishes: [{ recipeId: 'fanqiechaodan' }] });
    expect(noDiner.status).toBe(400);
    // 拒绝就是拒绝：不该在历史里留下半条
    expect((await getSlot('2025-06-01:dinner')).history).toEqual([]);
  });

  it('指向不存在的菜 / 人返回 400 并指认是哪一条', async () => {
    harness = createTestHarness();

    const badRecipe = await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: '不存在的菜' }] });
    expect(badRecipe.status).toBe(400);
    expect(badRecipe.body.error).toBe('unknown_recipe');
    expect(badRecipe.body.recipeId).toBe('不存在的菜');

    const badMember = await book('2025-06-01:dinner', {
      diners: ['mom', 'nobody'],
      dishes: [{ recipeId: 'fanqiechaodan' }],
    });
    expect(badMember.status).toBe(400);
    expect(badMember.body.error).toBe('unknown_member');
    expect(badMember.body.memberId).toBe('nobody');

    expect((await getSlot('2025-06-01:dinner')).history).toEqual([]);
  });

  it('同一道菜不能在一餐里出现两次', async () => {
    harness = createTestHarness();

    const { status, body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }, { recipeId: 'fanqiechaodan' }],
    });
    expect(status).toBe(400);
    expect(body.error).toBe('duplicate_dish');
  });

  it('草稿可以上餐（外部补位池要走的路）、退役不行（家里不再做）', async () => {
    harness = createTestHarness();

    // 草稿是外部菜谱池的补位菜：spec S6 要它上桌后才有转正的机会，提前堵死就断了那条路
    const draft = await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'xiangguhuaji' }] });
    expect(draft.status).toBe(200);
    expect(draft.body.slot?.menu?.dishes[0]?.name).toBe('香菇滑鸡');

    const retired = await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'xiangjiandaiyu' }] });
    expect(retired.status).toBe(400);
    expect(retired.body.error).toBe('recipe_retired');
  });

  it('预定的来源可标（手动 / 接受推荐），#17 按它区分留痕', async () => {
    harness = createTestHarness();

    const { body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'hongshaopaigu' }],
      source: 'recommendation',
    });
    expect(body.slot?.status).toBe('decided');
    expect((await getSlot('2025-06-01:dinner')).history[0]?.source).toBe('recommendation');
    // 缺省是手动
    await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    expect((await getSlot('2025-06-02:dinner')).history[0]?.source).toBe('manual');
  });
});

/**
 * 取消（总纲 §2.1）：已定 → 未定，历史留痕。取消是**唯一**能把餐槽退回未定的手段，
 * 但取消本身也是一条不可变事件——历史不删。
 */
describe('取消餐槽', () => {
  it('取消后回到未定，历史里留着预定的痕迹', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    const { status } = await cancel('2025-06-01:dinner');
    expect(status).toBe(200);

    const { slot, history } = await getSlot('2025-06-01:dinner');
    expect(slot.status).toBe('undecided');
    expect(slot.menu).toBeNull();
    expect(history.map((event) => event.type)).toEqual(['decide', 'cancel']);
    // 取消事件本身不带用餐者与菜品（它表达的是「这一餐没有了」）
    expect(history[1]?.dishes).toEqual([]);
    expect(history[1]?.diners).toEqual([]);
    // 但被取消的那份菜单仍然能从第一条事件里读出来
    expect(history[0]?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨', '蒜蓉菜心', '冬瓜排骨汤']);
  });

  it('取消后还能重新定（未定 → 已定，历史继续追加）', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    await cancel('2025-06-01:dinner');
    const { status, body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'kelejichi' }],
    });
    expect(status).toBe(200);
    expect(body.slot?.status).toBe('decided');

    const { history } = await getSlot('2025-06-01:dinner');
    // 重新定是「预定」而不是「改餐」：取消之后的餐槽就是未定的（折叠的语义）
    expect(history.map((event) => event.type)).toEqual(['decide', 'cancel', 'decide']);
  });

  it('取消一个没定的餐槽返回 404（没有可取消的东西）', async () => {
    harness = createTestHarness();

    const { status, body } = await cancel('2025-06-01:dinner');
    expect(status).toBe(404);
    expect(body.error).toBe('not_decided');
    // 不存在的餐槽不该因此留下事件
    expect((await getSlot('2025-06-01:dinner')).history).toEqual([]);
  });

  it('已过截止时刻的餐仍可取消（撤掉一个定错了的餐不需要赶时间）', async () => {
    harness = createTestHarness();

    harness.clock.set('2025-06-01T02:00:00.000Z'); // 家庭时区 10:00，午餐还没过
    await book('2025-06-01:lunch', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });

    harness.clock.set('2025-06-01T12:00:00.000Z'); // 家庭时区 20:00，午餐早过了
    const { status } = await cancel('2025-06-01:lunch');
    expect(status).toBe(200);
    expect((await getSlot('2025-06-01:lunch')).slot.status).toBe('undecided');
  });

  it('取消两次：第二次是 404（已经未定了）', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    await cancel('2025-06-01:dinner');
    const { status, body } = await cancel('2025-06-01:dinner');
    expect(status).toBe(404);
    expect(body.error).toBe('not_decided');
    // 也不该留下第二条取消事件
    expect((await getSlot('2025-06-01:dinner')).history.length).toBe(2);
  });
});

/**
 * 「最近吃过」（总纲 §3 决议 3：直接查事件流，不另建汇总表）。
 * 去重窗口 7 天是家规（§4），M1 写死。
 */
describe('最近吃过', () => {
  async function recentDishes(days = 7) {
    const { status, body } = await harness.json<{ dishes: { recipeId: string; name: string; times: number; slotId: string }[] }>(
      `/api/history/recent-dishes?days=${days}`,
    );
    expect(status).toBe(200);
    return body.dishes;
  }

  it('吃过（已上桌）的菜才进窗口，明天要做的还不算吃过', async () => {
    harness = createTestHarness();

    // 5-31 上午定当晚晚餐（定的时候还没过截止）；6-01 上午再看：昨晚那餐已上桌
    harness.clock.set('2025-05-31T02:00:00.000Z');
    await book('2025-05-31:dinner', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });

    harness.clock.set('2025-06-01T02:00:00.000Z');
    await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });

    const dishes = await recentDishes(7);
    expect(dishes.map((dish) => dish.name)).toEqual(['红烧排骨']);

    // 时间走到今晚之后：可乐鸡翅也算吃过了，且比排骨近
    harness.clock.set('2025-06-01T14:00:00.000Z');
    const later = await recentDishes(7);
    expect(later.map((dish) => dish.name)).toEqual(['可乐鸡翅', '红烧排骨']);
  });

  it('窗口外的旧菜不算（7 天去重窗口的口径）', async () => {
    harness = createTestHarness();

    harness.clock.set('2025-05-20T02:00:00.000Z'); // 12 天前
    await book('2025-05-20:dinner', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });

    harness.clock.set('2025-06-01T02:00:00.000Z');
    expect(await recentDishes(7)).toEqual([]);
    // 窗口放宽到 14 天就看得见了
    expect((await recentDishes(14)).map((dish) => dish.name)).toEqual(['红烧排骨']);
  });

  it('同一道菜出现在多餐时给次数，去重成一条', async () => {
    harness = createTestHarness();

    harness.clock.set('2025-05-29T02:00:00.000Z');
    await book('2025-05-29:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    harness.clock.set('2025-05-30T02:00:00.000Z');
    await book('2025-05-30:dinner', { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] });
    harness.clock.set('2025-06-01T02:00:00.000Z');

    const dishes = await recentDishes(7);
    expect(dishes.length).toBe(1);
    expect(dishes[0]).toMatchObject({ recipeId: 'fanqiechaodan', name: '番茄炒蛋', times: 2 });
    // 给出的是窗口内最近一次那一餐（去重软避让要知道「多久没吃了」）
    expect(dishes[0]?.slotId).toBe('2025-05-30:dinner');
  });

  it('取消掉的餐不算吃过，改掉的旧版本也不算（只认每餐槽当前有效的菜单）', async () => {
    harness = createTestHarness();

    harness.clock.set('2025-05-30T02:00:00.000Z');
    await book('2025-05-30:dinner', { diners: ALL, dishes: [{ recipeId: 'hongshaopaigu' }] });
    await cancel('2025-05-30:dinner');
    await book('2025-05-30:dinner', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });

    // 先把这一餐改成别的菜：改掉的旧版本不该被当成吃过
    harness.clock.set('2025-05-31T02:00:00.000Z');
    await book('2025-05-31:dinner', { diners: ALL, dishes: [{ recipeId: 'tudouniuniu' }] });
    await book('2025-05-31:dinner', { diners: ALL, dishes: [{ recipeId: 'mapodoufu' }] });
    harness.clock.set('2025-06-01T02:00:00.000Z');

    const dishes = await recentDishes(7);
    expect(dishes.map((dish) => dish.name).sort()).toEqual(['可乐鸡翅', '麻婆豆腐']);
    expect(dishes.map((dish) => dish.name)).not.toContain('红烧排骨');
    expect(dishes.map((dish) => dish.name)).not.toContain('土豆炖牛腩');
  });

  it('days 参数越界被 zod 拦下', async () => {
    harness = createTestHarness();

    const { status, body } = await harness.json<{ error: string }>('/api/history/recent-dishes?days=999');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
  });
});

/**
 * 换一整套与撤销（#18、spec §2.3：「换一整套」重新生成且**可反悔**回上一套）。
 *
 * 语义归属的决定（#17 审查留下的欠账）：`replace_set` 同时承接「接受整餐推荐」（#17）
 * 与「换一整套」（#18），两者在语义上本来就是同一件事——整餐重新生成；区别只在
 * **这一套是怎么来的**，那正是 `source` 的含义：
 *   * `replace_set` + `recommendation` = 换一整套（可撤销）；
 *   * `replace_set` + `manual` = 撤销本身（撤销之后不可再撤销：没有 ping-pong）。
 * 用 source 而不是新造事件类型：`replace_set` 在 002 的 CHECK 里已备好，加枚举要重建
 * append-only 表（#15 特意为此预留过枚举）。
 */
describe('换一整套的撤销', () => {
  async function acceptSet(dishes: string[], slotId = '2025-06-01:dinner'): Promise<void> {
    const { status } = await book(slotId, {
      diners: ALL,
      dishes: dishes.map((recipeId) => ({ recipeId })),
      source: 'recommendation',
    });
    expect(status).toBe(200);
  }

  it('撤销把菜单恢复成「换一整套」之前那一套，并留痕（append-only：不删中间那条）', async () => {
    harness = createTestHarness();
    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    expect((await getSlot('2025-06-01:dinner')).slot.canUndoSet).toBe(false);

    await acceptSet(['kelejichi', 'culutudousi']);
    const afterSet = await getSlot('2025-06-01:dinner');
    expect(afterSet.history.map((event) => event.type)).toEqual(['decide', 'replace_set']);
    expect(afterSet.slot.canUndoSet).toBe(true);

    const { status, body } = await undoSet('2025-06-01:dinner');
    expect(status).toBe(200);
    expect(body.slot?.menu?.dishes.map((dish) => dish.recipeId)).toEqual(DINNERS);
    expect(body.slot?.menu?.diners.map((diner) => diner.memberId)).toEqual(ALL);

    const undone = await getSlot('2025-06-01:dinner');
    // 撤销是一条 replace_set + manual 的新事件，历史继续变长
    expect(undone.history.map((event) => event.type)).toEqual(['decide', 'replace_set', 'replace_set']);
    expect(undone.history[2]?.source).toBe('manual');
    // 撤销后不再可撤销（没有 ping-pong）
    expect(undone.slot.canUndoSet).toBe(false);
  });

  it('连着撤销两次 → 第二次 409 nothing_to_undo（撤销只走一步）', async () => {
    harness = createTestHarness();
    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    await acceptSet(['kelejichi', 'culutudousi']);

    expect((await undoSet('2025-06-01:dinner')).status).toBe(200);
    const second = await undoSet('2025-06-01:dinner');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('nothing_to_undo');
    // 第二次失败不该留下第三条事件
    expect((await getSlot('2025-06-01:dinner')).history).toHaveLength(3);
  });

  it('没有「换一整套」可撤的场景都返回 409：没定过、只定过一次、手动改过餐', async () => {
    harness = createTestHarness();

    // 没定过
    expect((await undoSet('2025-06-01:dinner')).status).toBe(409);

    // 只有一条预定事件（decide 不是 replace_set）
    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    expect((await undoSet('2025-06-01:dinner')).status).toBe(409);

    // 手动改餐（replace + manual）也不算「换一整套」
    await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    expect((await getSlot('2025-06-01:dinner')).history.map((event) => event.type)).toEqual(['decide', 'replace']);
    expect((await undoSet('2025-06-01:dinner')).status).toBe(409);
  });

  it('撤销之后菜单能被正常读出来（份量也跟着回来）', async () => {
    harness = createTestHarness();
    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    await acceptSet(['kelejichi', 'culutudousi']);
    await undoSet('2025-06-01:dinner');

    const { status, body } = await harness.json<{ slot: { portion: { dishes: { recipeId: string }[] } } }>(
      '/api/slots/2025-06-01:dinner',
    );
    expect(status).toBe(200);
    expect(body.slot.portion.dishes.map((dish) => dish.recipeId)).toEqual(DINNERS);
  });

  it('已过截止时刻的餐仍可撤销（撤掉一次手滑的换套不需要赶时间，与取消同一口径）', async () => {
    harness = createTestHarness();
    harness.clock.set('2025-06-01T02:00:00.000Z'); // 家庭时区 10:00，晚餐还没过
    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    await acceptSet(['kelejichi', 'culutudousi']);

    harness.clock.set('2025-06-01T14:30:00.000Z'); // 家庭时区 22:30，晚餐早过了
    const { status, body } = await undoSet('2025-06-01:dinner');
    expect(status).toBe(200);
    expect(body.slot?.editable).toBe(false);
    expect(body.slot?.canUndoSet).toBe(false);
  });

  it('撤销后的菜单与更早的历史都在：撤销不改写任何一条旧事件', async () => {
    harness = createTestHarness();
    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });
    await acceptSet(['kelejichi', 'culutudousi']);
    await undoSet('2025-06-01:dinner');

    const { history } = await getSlot('2025-06-01:dinner');
    expect(history[0]?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨', '蒜蓉菜心', '冬瓜排骨汤']);
    expect(history[1]?.dishes.map((dish) => dish.name)).toEqual(['可乐鸡翅', '醋溜土豆丝']);
    expect(history[2]?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨', '蒜蓉菜心', '冬瓜排骨汤']);
  });

  it('accept 一份整餐推荐（#17 的路径）之后也能撤销——两条路共用 replace_set', async () => {
    harness = createTestHarness();
    await book('2025-06-01:dinner', { diners: ALL, dishes: DINNERS.map((recipeId) => ({ recipeId })) });

    // 整餐推荐 → 一键接受（source='recommendation' + llm 元数据）
    const accepted = await harness.json<{ slot: SlotJson }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        diners: ALL,
        dishes: [{ recipeId: 'kelejichi' }, { recipeId: 'culutudousi' }],
        source: 'recommendation',
        llm: { model: 'fake-llm', promptVersion: PROMPT_VERSION, latencyMs: 3, degraded: false },
      }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.slot.canUndoSet).toBe(true);

    const { body } = await undoSet('2025-06-01:dinner');
    expect(body.slot?.menu?.dishes.map((dish) => dish.recipeId)).toEqual(DINNERS);
  });
});

/**
 * 掌勺者按**餐槽**指定（本票需求变更：从家人身上的全局标记 → 跟着每一餐走）。
 *
 * 覆盖四条钉子：
 *   * 定餐/改餐接受「这餐谁掌勺」，读接口折叠出当前生效的那位；
 *   * 不传时回落全局 `is_cook`（「家里通常谁做菜」是缺省值，不是权威判定）；
 *   * 存的是**当时的快照**（姓名/头像），家人被软删除后历史菜单里也读得出当时的名字；
 *   * 只改掌勺者（菜单内容不变）也要追一条留痕——「随时可以改」不是双击去重能吞掉的。
 */
describe('掌勺者按餐指定', () => {
  it('定餐时指定掌勺者，嵌在读接口的响应里', async () => {
    harness = createTestHarness();

    const { status, body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    expect(status).toBe(200);
    expect(body.slot?.cook).toMatchObject({ memberId: 'dad', name: '爸爸', emoji: '👨' });

    // 单餐读接口也带得出来（同一条折叠）
    expect((await getSlot('2025-06-01:dinner')).slot.cook?.name).toBe('爸爸');
    // 列表接口同样（大卡/紧凑流/极简视图都从它取数）
    const listed = (await listSlots(1)).slots.find((slot) => slot.id === '2025-06-01:dinner');
    expect(listed?.cook?.memberId).toBe('dad');
  });

  it('不传 cook 时按上一餐继承，没有上一餐才回落 is_cook（种子里是妈妈）', async () => {
    harness = createTestHarness();

    // 新库、没有任何带掌勺者的餐：按上一餐继承落空 → 回落 is_cook（妈妈）
    const first = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
    });
    expect(first.status).toBe(200);
    expect(first.body.slot?.cook).toMatchObject({ memberId: 'mom', name: '妈妈' });
  });

  it('不传 cook 时按**上一餐**继承（前一餐指定了爸爸，后一餐不传就是爸爸）', async () => {
    harness = createTestHarness();

    // 今晚的晚餐由爸爸掌勺
    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    // 明天的午餐不传 cook：照上一餐（今晚晚餐）继承 → 爸爸，而不是全局 is_cook 的妈妈
    const next = await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    expect(next.status).toBe(200);
    expect(next.body.slot?.cook).toMatchObject({ memberId: 'dad', name: '爸爸' });

    // 继承链会继续往后传：再下一餐也是爸爸
    const after = await book('2025-06-02:dinner', { diners: ALL, dishes: [{ recipeId: 'culutudousi' }] });
    expect(after.body.slot?.cook?.memberId).toBe('dad');
  });

  it('餐次顺序按“同一日午餐 ≤ 晚餐”排：同日午餐不会误把晚餐当成上一餐', async () => {
    harness = createTestHarness();

    // 先定 6-02 晚餐（爸爸），再定**同日午餐**不传 cook（两餐都在未来，都定得下来）：
    // 午餐的上一餐应该是更早的（无 → 回落 is_cook 妈妈），而不是把当天晚餐当成“上一餐”。
    // 二者碰巧都可能是妈妈，所以把晚餐换成爸爸才能区分。
    await book('2025-06-02:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    const lunch = await book('2025-06-02:lunch', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    // 如果没有显式排餐次（dinner < lunch 的字符串序），这里会错拿到爸爸；正确结果是妈妈（is_cook）
    expect(lunch.body.slot?.cook?.memberId).toBe('mom');
  });

  it('继承只看**当前有效**的事件：前一餐被取消/改掉旧掌勺者后，继承走更早的那位', async () => {
    harness = createTestHarness();

    // 早上定午餐（妈妈）→ 改餐把掌勺者换成爸爸 → 取消这一餐
    await book('2025-06-01:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'mom',
    });
    await book('2025-06-01:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    await cancel('2025-06-01:lunch');
    // 取消之后这一餐没有掌勺者，且它是最后一个带 cook 的？→ 取消事件不带 cook，
    // 但“上一餐”取的是**每个餐槽最后一条事件**里非空的掌勺者——取消事件那条不再携带，
    // 所以午餐被取消后，它的掌勺者不再算数 → 落回 is_cook（妈妈）。
    const dinner = await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    expect(dinner.body.slot?.cook?.memberId).toBe('mom');
  });

  it('继承不会拿到一位已被软删除的上一餐掌勺者（新写的餐里不出现已删家人）', async () => {
    harness = createTestHarness();

    // 午餐由姥姥掌勺（新建一位，不碰种子）
    const created = await harness.json<{ member: { id: string } }>('/api/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '姥姥', emoji: '👵', kind: 'adult', gender: 'female' }),
    });
    const granny = created.body.member.id;
    await book('2025-06-01:lunch', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: granny,
    });
    await harness.json(`/api/members/${granny}`, { method: 'DELETE' });

    // 晚餐不传 cook：姥姥已被软删，不能把一位已删的人继承过来 → 跳过她，回落 is_cook（妈妈）
    const dinner = await book('2025-06-01:dinner', { diners: ALL, dishes: [{ recipeId: 'kelejichi' }] });
    expect(dinner.body.slot?.cook?.memberId).toBe('mom');
  });

  it('读接口下发 cookDefault：未定餐槽的界面不必自己拼“缺省会是谁”', async () => {
    harness = createTestHarness();

    // 把今晚晚餐定给爸爸
    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    // 明天午餐未定：`cook` 为 null（未指定），`cookDefault` 是按上一餐继承出来的爸爸
    const lunch = (await listSlots(3)).slots.find((slot) => slot.id === '2025-06-02:lunch');
    expect(lunch?.cook).toBeNull();
    expect(lunch?.cookDefault).toMatchObject({ memberId: 'dad', name: '爸爸' });
    // 已定餐槽也带 cookDefault（同一个现算），但 `cook` 是当时的快照
    const dinner = (await listSlots(3)).slots.find((slot) => slot.id === '2025-06-01:dinner');
    expect(dinner?.cook?.memberId).toBe('dad');
  });

  it('显式 cook:null 表示这一餐不指定掌勺者', async () => {
    harness = createTestHarness();

    const { status, body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: null,
    });
    expect(status).toBe(200);
    expect(body.slot?.cook).toBeNull();
    expect((await getSlot('2025-06-01:dinner')).slot.cook).toBeNull();
  });

  it('改餐可以随时换掌勺者，留痕里每条都带当时的快照', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'mom',
    });
    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });

    const { slot, history } = await getSlot('2025-06-01:dinner');
    expect(slot.cook?.memberId).toBe('dad');
    expect(history.map((event) => event.cook?.memberId)).toEqual(['mom', 'dad']);
    // 菜单内容没变但掌勺者变了：仍然要留痕（“随时可以改”不是双击去重能吞掉的）
    expect(history.map((event) => event.type)).toEqual(['decide', 'replace']);
  });

  it('只改掌勺者、菜单内容一模一样，也追一条留痕（与“双击保存不重复”只对全同提交生效）', async () => {
    harness = createTestHarness();

    const menu = { diners: ALL, dishes: [{ recipeId: 'fanqiechaodan' }] };
    await book('2025-06-01:dinner', { ...menu, cook: 'mom' });
    // 全同提交（含 cook）不追事件
    await book('2025-06-01:dinner', { ...menu, cook: 'mom' });
    expect((await getSlot('2025-06-01:dinner')).history).toHaveLength(1);
    // 只改掌勺者：追一条
    await book('2025-06-01:dinner', { ...menu, cook: 'dad' });
    expect((await getSlot('2025-06-01:dinner')).history).toHaveLength(2);
  });

  it('只改掌勺者不把买菜清单标成「菜单变了」（改的是谁做，不是要买什么）', async () => {
    harness = createTestHarness();
    const menu = { diners: ['mom', 'dad'], dishes: [{ recipeId: 'hongshaopaigu' }] };
    await book('2025-06-01:dinner', { ...menu, cook: 'mom' });

    // 建一份进行中的清单
    const created = await harness.json<{ list: { stale: boolean } | null }>('/api/grocery');
    expect(created.status, `开清单失败：${JSON.stringify(created.body)}`).toBe(200);
    expect(created.body.list?.stale).toBe(false);

    // 只换掌勺者：留痕追一条，但清单不该过期（否则界面上会冒出“菜单变了”的假警告）
    await book('2025-06-01:dinner', { ...menu, cook: 'dad' });
    const afterCook = await harness.json<{ list: { stale: boolean } | null }>('/api/grocery');
    expect(afterCook.body.list?.stale).toBe(false);

    // 真改菜单（换一道菜）：清单必须过期（“菜单变了”是真的）
    await book('2025-06-01:dinner', {
      diners: ['mom', 'dad'],
      dishes: [{ recipeId: 'kelejichi' }],
      cook: 'dad',
    });
    const afterMenu = await harness.json<{ list: { stale: boolean } | null }>('/api/grocery');
    expect(afterMenu.body.list?.stale).toBe(true);
  });

  it('指定一位不是家人的人当掌勺者 → 400 unknown_member，一行不落', async () => {
    harness = createTestHarness();

    const { status, body } = await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'nobody',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_member');
    expect(body.memberId).toBe('nobody');
    expect((await getSlot('2025-06-01:dinner')).history).toEqual([]);
  });

  it('掌勺者被软删除后：历史菜单里照旧读得出当时的名字（快照），新定餐不能再指定他', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', {
      diners: ['dad', 'dabao'],
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    // 删掉爸爸（软删除，010）
    const removed = await harness.json('/api/members/dad', { method: 'DELETE' });
    expect(removed.status).toBe(200);

    // 历史菜单/当前折叠照旧读得出当时的姓名与头像——不留一个会显示 undefined 的洞
    const { slot, history } = await getSlot('2025-06-01:dinner');
    expect(slot.cook).toMatchObject({ memberId: 'dad', name: '爸爸', emoji: '👨' });
    expect(history[0]?.cook).toMatchObject({ memberId: 'dad', name: '爸爸' });

    // 新定餐不能再把已删的家人指定为掌勺者（与用餐者同一口径）
    const after = await book('2025-06-02:dinner', {
      diners: ['dabao'],
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    expect(after.status).toBe(400);
    expect(after.body.error).toBe('unknown_member');
  });

  it('取消之后掌勺者一并清掉（没有餐就没有“谁做”）', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    await cancel('2025-06-01:dinner');

    const { slot, history } = await getSlot('2025-06-01:dinner');
    expect(slot.cook).toBeNull();
    expect(slot.status).toBe('undecided');
    // 取消事件不带掌勺者；被取消那一餐的旧事件仍留着当时的掌勺者
    expect(history[1]?.cook).toBeNull();
    expect(history[0]?.cook?.memberId).toBe('dad');
  });

  it('撤销换一整套时掌勺者也回到上一套（与菜单内容一起退）', async () => {
    harness = createTestHarness();

    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: DINNERS.map((recipeId) => ({ recipeId })),
      cook: 'mom',
    });
    // 换一整套（recommendation）时把掌勺者换成爸爸
    await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'kelejichi' }],
      cook: 'dad',
      source: 'recommendation',
    });
    expect((await getSlot('2025-06-01:dinner')).slot.cook?.memberId).toBe('dad');

    await undoSet('2025-06-01:dinner');
    expect((await getSlot('2025-06-01:dinner')).slot.cook?.memberId).toBe('mom');
  });

  it('餐后回顾的一餐带出掌勺者（转正入口按它判定“谁是这一餐的掌勺者”）', async () => {
    harness = createTestHarness();
    harness.clock.set('2025-05-31T02:00:00.000Z'); // 家庭时区 10:00
    await book('2025-05-31:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      cook: 'dad',
    });
    harness.clock.set('2025-06-01T02:00:00.000Z'); // 那一餐已上桌

    const { body } = await harness.json<{ meals: { slotId: string; cook: { memberId: string } | null }[] }>(
      '/api/feedback?days=30',
    );
    expect(body.meals.find((meal) => meal.slotId === '2025-05-31:dinner')?.cook?.memberId).toBe('dad');
  });
});

/**
 * `promptVersion` 收紧（#17 审查欠账）：`llm` 元数据由客户端回传（推荐不落库，总纲 §4），
 * 只校验形状的话任何字符串都能写进 append-only 的留痕——而留痕的全部价值是可信回溯。
 * 两条都要：版本号①在代码库里存在，②**是产生它的那条路该用的模板**。
 * 候选模板的版本号即使真实存在也不能写进整餐推荐的留痕：那会让历史推荐对回另一张模板。
 */
describe('LLM 元数据的 prompt 版本校验', () => {
  async function acceptWithVersion(promptVersion: string) {
    return await book('2025-06-01:dinner', {
      diners: ALL,
      dishes: [{ recipeId: 'fanqiechaodan' }],
      source: 'recommendation',
      llm: { model: 'fake-llm', promptVersion, latencyMs: 1, degraded: false },
    });
  }

  it('已知版本（整餐推荐模板）通过并进留痕', async () => {
    harness = createTestHarness();
    const { status } = await acceptWithVersion(PROMPT_VERSION);
    expect(status).toBe(200);
    const { history } = await getSlot('2025-06-01:dinner');
    expect(history[0]?.llm?.promptVersion).toBe(PROMPT_VERSION);
  });

  it('伪造的版本号 → 400 unknown_prompt_version，且一行都不落库', async () => {
    harness = createTestHarness();
    const { status, body } = await acceptWithVersion('v-我自己编的');
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_prompt_version');
    expect((await getSlot('2025-06-01:dinner')).history).toEqual([]);
  });

  it('换菜候选模板的版本号 → 400：模板与来源绑定，候选模板不产生这条留痕', async () => {
    harness = createTestHarness();
    const { status, body } = await acceptWithVersion(CANDIDATE_PROMPT_VERSION);
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_prompt_version');
    // 拒收就是一行不落：留痕里不能出现「整餐推荐用了候选模板」这条假证据
    expect((await getSlot('2025-06-01:dinner')).history).toEqual([]);
  });
});
