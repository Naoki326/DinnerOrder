import { expect, test, type Page } from '@playwright/test';
import { E2E, ROOT_URL } from './test-env';

/**
 * 验收场景 S9（视图模式，总纲 §2.10、spec §8）：
 *  * 视图模式是**设备本地的偏好**（与「当前身份」同级）：设置里三选一，默认 A（下一餐大卡），
 *    刷新仍在、不跨设备共享；
 *  * 原型底部的黑色胶囊「变体切换条」是**评审工具**，不得进产品；
 *  * B（掌勺者紧凑流）与 C（长辈小孩极简）两套视图落地；
 *  * 三套视图**数据模型与操作语义一致**：同一个「定一餐」在任一套视图里走过去，
 *    服务端得到逐字段相同的结果（呈现不同而已；「吃剩的」同理，见下方第二条对照用例）；
 *  * E2E 闭环：先切视图、再走完同一条定餐流程。
 *
 * 时间基准是真实时钟（webServer 不注入假时钟），餐槽 id 一律现取不写死；
 * 留痕 append-only，断言只相对本次操作。
 */
interface SlotJson {
  id: string;
  date: string;
  meal: 'lunch' | 'dinner';
  status: 'undecided' | 'decided';
  menu: {
    dishes: { recipeId: string; name: string; keepLeftover: boolean }[];
    diners: { memberId: string; name: string }[];
    leftoverSlotId: string | null;
  } | null;
  /** 晚餐「吃剩的」的来源（服务端推导：同日午餐已定且标了留量） */
  leftoverSource: { slotId: string; dishes: { recipeId: string; name: string }[] } | null;
  /** 本餐份量（服务端现算；留量那一餐的逐菜上浮读数在里面） */
  portion: { uplift: number; dishes: { recipeId: string; uplift: number }[] } | null;
}

interface HistoryJson {
  type: string;
  source: string;
  leftoverSlotId: string | null;
  llm: { model: string; promptVersion: string; degraded: boolean } | null;
  diners: { memberId: string }[];
}

/** 清场：窗口内已定的餐槽全取消（每套视图都要一张干净的未定大卡） */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
  }
}

/** 窗口内最近的未定餐槽（A 的大卡 / B 的第一行 / C 的下一件事是同一个） */
async function nextUndecidedSlot(page: Page): Promise<string> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  const slot = slots.find((item) => item.status === 'undecided');
  if (!slot) throw new Error('窗口内没有未定的餐槽，清场逻辑出问题了');
  return slot.id;
}

/** 打开设置（⚙️）把视图模式切成指定的一套——产品里的入口，不是原型的胶囊条 */
async function switchView(page: Page, mode: 'A' | 'B' | 'C'): Promise<void> {
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId(`view-mode-option-${mode}`).click();
  await expect(page.getByTestId('settings-sheet')).toBeHidden();
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

test('视图模式是设备本地设置：默认 A、设置里三选一、刷新仍在而不跨设备（S9）', async ({ page, browser }) => {
  await page.goto(`${ROOT_URL}/`);

  // 默认 A：下一餐大卡
  await expect(page.getByTestId('home-view')).toBeVisible();
  await expect(page.getByTestId('empty-slot')).toBeVisible();

  // 原型底部的黑色胶囊变体切换条是评审工具，不是产品功能
  await expect(page.locator('#proto-bar')).toHaveCount(0);
  await expect(page.locator('[aria-label="下一个变体"]')).toHaveCount(0);

  // 设置里三选一，默认那一套标着「当前」
  await page.getByTestId('settings-button').click();
  const sheet = page.getByTestId('settings-sheet');
  await expect(sheet).toBeVisible();
  for (const mode of ['A', 'B', 'C'] as const) {
    await expect(page.getByTestId(`view-mode-option-${mode}`)).toBeVisible();
  }
  await expect(page.getByTestId('view-mode-option-A')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('view-mode-option-B')).toHaveAttribute('aria-pressed', 'false');

  // 切到 B：设置收起、B 视图立刻上屏
  await page.getByTestId('view-mode-option-B').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('compact-view')).toBeVisible();

  // 本设备持久：刷新后仍是 B（它不进画像、不上服务端，只能是设备本地的）
  await page.reload();
  await expect(page.getByTestId('compact-view')).toBeVisible();

  // 不跨设备：**此刻**另一台手机打开还是默认 A——这台刚切成 B，
  // 所以「存成服务端全局」的实现会在这里得到 B 而失败
  const otherPhone = await browser.newContext({ viewport: E2E.viewport });
  const otherPage = await otherPhone.newPage();
  await otherPage.goto(`${ROOT_URL}/`);
  await expect(otherPage.getByTestId('home-view')).toBeVisible();
  await otherPhone.close();

  // B → C：切到极简视图，刷新也仍在 C
  await switchView(page, 'C');
  await expect(page.getByTestId('simple-view')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('simple-view')).toBeVisible();

  // 回到 A：三选一里没有单向门
  await switchView(page, 'A');
  await expect(page.getByTestId('home-view')).toBeVisible();
});

interface BookingSnapshot {
  status: string;
  dishes: { recipeId: string; keepLeftover: boolean }[];
  diners: string[];
  /** 菜单上的「吃剩的」引用（#22）：普通菜单 / 推荐那一套都是 null */
  leftoverOf: string | null;
  /** 本餐逐菜的上浮系数（服务端现算；这一餐读的是被引用那一餐多做的那一份） */
  uplift: number[];
  lastEvent: string;
  lastSource: string;
  /** 末条留痕的「吃剩的」引用（事件流要能回答「为什么这顿没新采购」） */
  lastLeftoverOf: string | null;
  /** 留痕里的 LLM 元数据：只取**语义**字段。`latencyMs` 刻意不进对照——它是真实耗时，
   *  同一条路重跑也会 0ms/1ms 地跳，拿它比会把「语义一致」变成随机红。 */
  lastLlm: { model: string; promptVersion: string; degraded: boolean } | null;
}

/** 服务端此刻的真实状态：状态 + 菜单（含每道菜的留量）+ 末条留痕（类型/source/LLM 元数据） */
async function bookingSnapshot(page: Page, slotId: string): Promise<BookingSnapshot> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot, history } = (await response.json()) as { slot: SlotJson; history: HistoryJson[] };
  const last = history.at(-1);
  return {
    status: slot.status,
    dishes: (slot.menu?.dishes ?? []).map((dish) => ({ recipeId: dish.recipeId, keepLeftover: dish.keepLeftover })),
    diners: (slot.menu?.diners ?? []).map((diner) => diner.memberId),
    leftoverOf: slot.menu?.leftoverSlotId ?? null,
    uplift: (slot.portion?.dishes ?? []).map((dish) => dish.uplift),
    lastEvent: last?.type ?? '',
    lastSource: last?.source ?? '',
    lastLeftoverOf: last?.leftoverSlotId ?? null,
    lastLlm: last?.llm
      ? { model: last.llm.model, promptVersion: last.llm.promptVersion, degraded: last.llm.degraded }
      : null,
  };
}

/** 全家人（种子的 sort_order）：「不传名单 = 全员」的那一份（总纲 §3、§4） */
const ALL_MEMBERS = ['mom', 'dad', 'dabao', 'xiaobao'] as const;

/** 窗口内的餐槽（日期×餐次顺序） */
async function listSlots(page: Page, days: number): Promise<SlotJson[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  expect(response.ok(), `餐槽列表没要回来：HTTP ${response.status()}`).toBe(true);
  return ((await response.json()) as { slots: SlotJson[] }).slots;
}

/**
 * 留量（S4）的前置布置：把「同日午餐 + 晚餐」摆成三套视图都能走到的场景。
 *
 * 留量**需要前置**（同日午餐已定且至少一道菜标了留量），所以不能塞进上面那条「定一餐」用例：
 * 那一条的主题是「推荐 → 接受」，多一个前置会把两件事混成一团。这也是本文件第二条对照用例
 * （A/B/C 各走一趟留量 → 服务端逐字段一致）的由来。
 */
async function bookLeftoverLunch(page: Page): Promise<{ lunch: string; dinner: string }> {
  const slots = await listSlots(page, 3);
  // 窗口里最近的午餐 + 同日晩餐（今天午餐过了截止时刻时，那就是明天的这一对）
  const lunch = slots.find((slot) => slot.meal === 'lunch');
  expect(lunch, '窗口内至少要有一张午餐').toBeTruthy();
  const dinner = slots.find((slot) => slot.meal === 'dinner' && slot.date === lunch!.date);
  expect(dinner, `${lunch!.date} 的晚餐也要在窗口里（吃剩的是当日晚餐）`).toBeTruthy();

  // 目标午餐必须是「最近未定餐槽」：A 的大卡与 C 的主屏都取那一张（三套视图才能各走各的入口）。
  // 排在它前面的都已经在清场里退回未定了，先定掉它们当垫场。
  for (const slot of slots) {
    if (slot.id === lunch!.id) break;
    const response = await page.request.put(`${ROOT_URL}/api/slots/${slot.id}`, {
      data: { diners: [...ALL_MEMBERS], dishes: [{ recipeId: 'fanqiechaodan' }] },
    });
    expect(response.ok(), `给 ${slot.id} 定一餐当垫场失败：HTTP ${response.status()}`).toBe(true);
  }

  // 午餐：排骨标留量 + 一道没标的不标（上浮是单道级的）——「吃剩的」由服务端从这个快照推导
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${lunch!.id}`, {
    data: {
      diners: [...ALL_MEMBERS],
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }, { recipeId: 'suanrongcaixin' }],
    },
  });
  expect(booked.ok(), `午餐没定上：HTTP ${booked.status()}`).toBe(true);
  return { lunch: lunch!.id, dinner: dinner!.id };
}

/** 单餐快照：用餐者名单里标了留量的那几道（服务端现推导） */
async function keptDishes(page: Page, slotId: string): Promise<DishSnapshot> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot } = (await response.json()) as { slot: SlotJson };
  return (slot.menu?.dishes ?? [])
    .filter((dish) => dish.keepLeftover)
    .map((dish) => ({ recipeId: dish.recipeId, keepLeftover: dish.keepLeftover }));
}

type DishSnapshot = { recipeId: string; keepLeftover: boolean }[];

/**
 * 服务端为这一餐现算的那一份整餐推荐——三条路提交的内容都必须是它。
 *
 * 这一趟是**独立于任何 UI 路径的基准**（直接打同一条 `/recommendation` 接口，fake LLM 确定性选菜），
 * 所以「A/B/C 结果一致」不再是「B/C 抄 A」：每条路各自都要与服务端的这一份逐字段对上。
 * 顺带验了「A 的面板不传名单」与「B/C 显式传全员」是同一个口径（服务端 `resolveDiners` 的默认 = 全员）。
 */
async function recommendFor(page: Page, slotId: string): Promise<{ recipeId: string }[]> {
  const response = await page.request.post(`${ROOT_URL}/api/slots/${slotId}/recommendation`, {
    data: { diners: [...ALL_MEMBERS] },
  });
  expect(response.ok(), `这一餐的推荐没要回来：HTTP ${response.status()}`).toBe(true);
  const { recommendation } = (await response.json()) as { recommendation: { dishes: { recipeId: string }[] } };
  return recommendation.dishes;
}

/** 落库是异步的，且三条路的终点各不相同：A 面板的接受、B 编辑器的换整套、C 向导的就这么吃 */
async function expectDecided(page: Page, slotId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
        const { slot } = (await response.json()) as { slot: SlotJson };
        return slot.status;
      },
      { timeout: 15_000 },
    )
    .toBe('decided');
}

/**
 * 一餐逐菜的上浮系数（服务端现算，`portion.dishes[].uplift`）。
 *
 * 它是「留量上浮真的生效了」的读数：午餐那几道标了留量的菜按家规系数算，没标的恒 1；
 * 「吃剩的」那一餐自己没有采购，读的是被引用那一餐多做的那一份——两边算出来是同一个数。
 * 界面不自己乘（#22 台账：不标未兑现的倍数），所以这个读数就是三条路要比的那一份。
 */
async function upliftsOf(page: Page, slotId: string): Promise<number[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot } = (await response.json()) as { slot: SlotJson };
  return (slot.portion?.dishes ?? []).map((dish) => dish.uplift);
}

/**
 * AC3「三视图操作语义一致性」的判别性对照：同一个「定一餐」＝接受一份整餐推荐（总纲 §2.1），
 * 三条路**各走各的实现、不共用同一个组件**：
 *   * A：大卡上的「给我推荐」面板 → 一键接受（`HomeView` 的 `RecommendationPanel`）；
 *   * B：紧凑流行内的「定」→ 编辑器 → 「换一整套」（`SlotView` 的 `replaceSet`，recommend → accept）；
 *   * C：极简视图的「给我们推荐」→ 两步向导 → 「就这么吃」（`SimpleView` 的 `SimpleWizard`）。
 *
 * 每条路的服务端快照都必须逐字段等于**服务端那一份推荐**（`recommendFor`）＋ 一条 decide 留痕：
 * 菜品（含留量）、名单、末条留痕的类型 / source / LLM 元数据。任何一条路自己漏字段、改名单、
 * 换来源（比如 C 的向导少提交一个字段、B 的换整套退回 manual），下面的逐字段断言就会红。
 */
test('三套视图操作语义一致：同一个「定一餐」在 A/B/C 各走自己的实现，服务端逐字段一致（S9）', async ({ page }) => {
  const snapshots: Record<'A' | 'B' | 'C', BookingSnapshot | undefined> = { A: undefined, B: undefined, C: undefined };
  const expected: Record<'A' | 'B' | 'C', DishSnapshot> = { A: [], B: [], C: [] };

  for (const mode of ['A', 'B', 'C'] as const) {
    await clearDecidedSlots(page);
    await page.goto(`${ROOT_URL}/`);
    await switchView(page, mode);
    const slotId = await nextUndecidedSlot(page);
    // 这一条路提交的菜品必须就是服务端这一份（推荐从不带留量：总纲 §4③ 留量是掌勺者事后标的）
    expected[mode] = (await recommendFor(page, slotId)).map((dish) => ({
      recipeId: dish.recipeId,
      keepLeftover: false,
    }));

    if (mode === 'A') {
      // A 的独有路：大卡上的推荐面板，一键接受
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.getByTestId('empty-slot')).toHaveAttribute('data-slot-id', slotId);
      await page.getByTestId('recommend-button').click();
      const panel = page.getByTestId('recommendation-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('accept-recommendation').click();
      await expect(panel).toBeHidden();
    } else if (mode === 'B') {
      // B 的独有路：行内的「定」进编辑器，在编辑器里「换一整套」（recommend → accept，同一套接口）
      await expect(page.getByTestId('compact-view')).toBeVisible();
      await page.getByTestId(`compact-book-${slotId}`).click();
      await expect(page).toHaveURL(`${ROOT_URL}/slot/${slotId}`);
      await expect(page.getByTestId('slot-status')).toHaveText('未定');
      // 名单默认全员（总纲 §3）：等家人列表到位再点，否则会带着空名单发请求
      await expect(page.getByTestId('diner-xiaobao')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('replace-set').click();
    } else {
      // C 的独有路：极简视图的两步向导（谁吃 → 吃这些 → 就这么吃）
      await expect(page.getByTestId('simple-view')).toBeVisible();
      await page.getByTestId('simple-recommend').click();
      await expect(page.getByTestId('simple-step-diners')).toBeVisible();
      // 不改名单（默认全员）：三条路的名单才可比
      await expect(page.getByTestId('simple-diner-xiaobao')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('simple-next').click();
      await expect(page.getByTestId('simple-step-review')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('simple-accept').click();
    }

    await expectDecided(page, slotId);

    // 定完视图没有被定餐流程改掉（三套视图连主界面的摆法都不同）
    const viewForMode = { A: 'home-view', B: 'compact-view', C: 'simple-view' }[mode];
    await page.goto(`${ROOT_URL}/`);
    await expect(page.getByTestId(viewForMode)).toBeVisible();
    snapshots[mode] = await bookingSnapshot(page, slotId);
  }

  // 逐字段对照：每条路各自都要落成「服务端那一份推荐 + 一条 decide 留痕」——不是「B/C 抄 A」
  for (const mode of ['A', 'B', 'C'] as const) {
    const snapshot = snapshots[mode]!;
    expect(snapshot.status, `${mode} 的餐槽状态`).toBe('decided');
    expect(snapshot.dishes, `${mode} 的菜品（含每道留量）`).toEqual(expected[mode]);
    expect(snapshot.diners, `${mode} 的用餐者名单`).toEqual([...ALL_MEMBERS]);
    expect(snapshot.lastEvent, `${mode} 的末条留痕类型`).toBe('decide');
    expect(snapshot.lastSource, `${mode} 的末条留痕来源`).toBe('recommendation');
    expect(snapshot.lastLlm?.model, `${mode} 留痕里的模型名`).toBe(E2E.fakeModel);
    expect(snapshot.lastLlm?.promptVersion, `${mode} 留痕里的模板版本`).toBe(snapshots.A!.lastLlm?.promptVersion);
    expect(snapshot.lastLlm?.degraded, `${mode} 留痕里的降级标记`).toBe(false);
  }
  // 三条路逐字段等价（三份实现：A 大卡面板 / B 编辑器换整套 / C 向导）
  expect(snapshots.B).toEqual(snapshots.A);
  expect(snapshots.C).toEqual(snapshots.A);
});

/**
 * AC3 的第二条判别性对照：同一个「吃剩的」（S4、总纲 §2.6）在 A/B/C 各走自己的实现，
 * 服务端逐字段一致。
 *
 * 为什么另写一条而不是塞进上面那条「定一餐」：留量需要**不同前置**——同日午餐得先定下、
 * 且至少一道菜标了留量（菜从那一餐现推导，本餐没有自己的菜品快照）。把两件事塞进一条会把
 * 「推荐 → 接受」那个主题搅浑。但判别力同构：三条路各走各的入口，对照基准是**独立打 API
 * 的服务端现算结果**（`keptDishes` + `upliftsOf`），不是「B/C 抄 A」：
 *   * A：大卡上的 `book-leftover-button`（`HomeView` 的 `HeroCard`）；
 *   * B：行内「定」→ 编辑器 → `leftover-entry` 里的 `book-leftover`（`SlotView`）；
 *   * C：极简主屏上的 `simple-leftover` 大按钮（`SimpleView`，本票补的入口）。
 *
 * 快照里含现推导的菜品（含 `keepLeftover`）、菜单上的引用（`leftoverOf`）、**逐菜上浮读数**与
 * 末条留痕：任一条路少提交一件东西（比如 C 漏了 `leftoverOf`、B 把名单改成非全员）
 * 或漏了服务端下发的条件（比如 C 自己拼“晚餐 + 同日午餐已定”），下面的断言就会红。
 *
 * ⚠️ 前置要把「同日午餐已定」摆好（`bookLeftoverLunch`）：A 的大卡与 C 的主屏都只展示
 * **最近未定的那一餐**，午餐已定后它们才指向同一张晚餐——三条路才走得通、也才可比。
 */
test('三套视图操作语义一致：「吃剩的」在 A/B/C 各走自己的实现，服务端逐字段一致（S9、S4）', async ({ page }) => {
  const snapshots: Record<'A' | 'B' | 'C', BookingSnapshot | undefined> = { A: undefined, B: undefined, C: undefined };
  // 三条路提交的必须是**同一份**服务端现推导的结果：午餐留量菜（排骨）+ 全员名单
  let expected: { dishes: DishSnapshot; diners: string[]; leftoverOf: string; uplift: number[] } | undefined;
  const { rules } = (await (await page.request.get(`${ROOT_URL}/api/family-rules`)).json()) as {
    rules: { leftoverUplift: number };
  };

  for (const mode of ['A', 'B', 'C'] as const) {
    await clearDecidedSlots(page);
    await page.goto(`${ROOT_URL}/`);
    await switchView(page, mode);
    // 前置：把同一张午餐定下（排骨标留量、素菜不标）——晚餐就是这一餐的引用方
    const { lunch, dinner } = await bookLeftoverLunch(page);
    // 前置是刚打 API 写进去的，页面的查询缓存还是切视图前那一份：重拉一次再断言界面
    await page.reload();

    // 基准：**独立打 API** 的服务端现算结果——本餐要吃的就是午餐标了留量的那几道（服务端推导）。
    // 上浮读数这里不读（此刻晚餐还没引用，上浮尚未生效）：它是「这一餐的每道菜 × 家规系数」
    // —— 拿家规的配置值算出期望，而不是拿某条 UI 路的读数去对齐。
    const base: NonNullable<typeof expected> = {
      dishes: await keptDishes(page, lunch),
      diners: [...ALL_MEMBERS],
      leftoverOf: lunch,
      uplift: [],
    };
    expect(base.dishes.map((dish) => dish.recipeId), '午餐要有留量菜可推（吃剩的基准）').toEqual(['hongshaopaigu']);
    base.uplift = base.dishes.map(() => rules.leftoverUplift);
    expected ??= base;
    // 三条路的前置必须逐字段相同（不然下面的对照比的不是同一件事）
    expect(base, `${mode} 的留量前置`).toEqual(expected);

    if (mode === 'A') {
      // A 的独有路：大卡上的留量按钮（午餐已定，这张大卡就是晚餐）
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.getByTestId('empty-slot')).toHaveAttribute('data-slot-id', dinner);
      await page.getByTestId('book-leftover-button').click();
    } else if (mode === 'B') {
      // B 的独有路：行内「定」进编辑器，在 `leftover-entry` 里预定
      await expect(page.getByTestId('compact-view')).toBeVisible();
      await page.getByTestId(`compact-book-${dinner}`).click();
      await expect(page).toHaveURL(`${ROOT_URL}/slot/${dinner}`);
      await expect(page.getByTestId('leftover-entry')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('book-leftover').click();
    } else {
      // C 的独有路：极简主屏上的大按钮（本票补的入口）
      await expect(page.getByTestId('simple-view')).toBeVisible();
      const button = page.getByTestId('simple-leftover');
      await expect(button).toBeVisible();
      // C 没有候选面板可展开：按钮上直接写着要吃的菜（与 A 同口径，服务端下发的那一份）
      await expect(button).toContainText('红烧排骨');
      await button.click();
    }

    await expectDecided(page, dinner);

    // 上浮真的生效了（不是纸面字段）：引用一旦成立，**午餐**那道留量菜与晚餐读的是同一个系数
    // （「有效引用」后才生效，所以只能在这时断言）
    expect(
      (await upliftsOf(page, lunch)).filter((value) => value > 1),
      `${mode} 走完后午餐的留量菜按家规系数上浮`,
    ).toEqual([rules.leftoverUplift]);

    // 定完视图没有被留量流程改掉（三套视图连主界面的摆法都不同）
    const viewForMode = { A: 'home-view', B: 'compact-view', C: 'simple-view' }[mode];
    await page.goto(`${ROOT_URL}/`);
    await expect(page.getByTestId(viewForMode)).toBeVisible();
    snapshots[mode] = await bookingSnapshot(page, dinner);
  }

  // 逐字段对照：每条路都要落成「引用同一个午餐 + 现推导来的菜 + 全员名单 + 一条 decide 留痕」
  for (const mode of ['A', 'B', 'C'] as const) {
    const snapshot = snapshots[mode]!;
    expect(snapshot.status, `${mode} 的餐槽状态`).toBe('decided');
    expect(snapshot.dishes, `${mode} 的菜品（现推导的留量菜）`).toEqual(expected!.dishes);
    expect(snapshot.diners, `${mode} 的用餐者名单`).toEqual(expected!.diners);
    expect(snapshot.leftoverOf, `${mode} 菜单上的「吃剩的」引用`).toBe(expected!.leftoverOf);
    expect(snapshot.uplift, `${mode} 该餐位的上浮读数`).toEqual(expected!.uplift);
    expect(snapshot.lastEvent, `${mode} 的末条留痕类型`).toBe('decide');
    expect(snapshot.lastSource, `${mode} 的末条留痕来源`).toBe('manual');
    expect(snapshot.lastLeftoverOf, `${mode} 留痕里的「吃剩的」引用`).toBe(expected!.leftoverOf);
    expect(snapshot.lastLlm, `${mode} 不该有 LLM 元数据（留量不是推荐）`).toBeNull();
  }
  // 三条路逐字段等价（三份实现：A 大卡按钮 / B 编辑器入口 / C 主屏大按钮）
  expect(snapshots.B).toEqual(snapshots.A);
  expect(snapshots.C).toEqual(snapshots.A);
});

/**
 * C 视图里「吃剩的」的可见性与取消（S4、S9）：定完之后要看得出这一餐吃的是剩的，
 * 并且能退回未定——与 A 的 `hero-leftover` / `cancel-leftover-button` 同一语义，
 * 只是换成这一屏的大字与大按钮。
 *
 * 这一条只管 C 自己的呈现与入口（上面那条管三视图的语义一致）；两条不重复：
 * 上面那条即使 C 只留一个能点的按钮（不显示说明、不能取消）也会绿。
 */
test('C 长辈小孩极简：吃剩的那一餐看得见、不吃能取消（S4、S9）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);
  await switchView(page, 'C');
  const { lunch, dinner } = await bookLeftoverLunch(page);
  await page.reload();

  // 未定的大按钮：菜名写在按钮上（服务端下发的那一份），本餐还没有自己的菜单快照
  const button = page.getByTestId('simple-leftover');
  await expect(button).toBeVisible();
  await expect(button).toContainText('红烧排骨');
  await button.click();

  // 定完：这一屏换成大字说明（看得出“这餐吃的是剩的、不另采购”），晚餐落成引用形态
  await expect(page.getByTestId('simple-leftover-note')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('simple-leftover-note')).toContainText('吃中午剩的');
  await expect(page.getByTestId('simple-leftover-done')).toBeVisible();
  await expectDecided(page, dinner);
  const saved = await bookingSnapshot(page, dinner);
  expect(saved.leftoverOf).toBe(lunch);
  expect(saved.dishes.map((dish) => dish.recipeId)).toEqual(['hongshaopaigu']);

  // 手机宽度：大按钮不吃宽度（C 给长辈小孩用，390 是 E2E 的固定视口）
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  // 取消（同一条 DELETE /slots/:id）：晚餐回到未定，大按钮回来——取消不是封禁
  await page.getByTestId('simple-cancel-leftover').click();
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${ROOT_URL}/api/slots/${dinner}`);
        const { slot } = (await response.json()) as { slot: SlotJson };
        return slot.status;
      },
      { timeout: 15_000 },
    )
    .toBe('undecided');
  // 取消的是晚餐自己，午餐的留量来源还在 → 大按钮回来，还能再定一次
  await expect(page.getByTestId('simple-leftover')).toBeVisible();

  // 再定一次，验「👍 好」收掉这一步：回到「一屏一事」的下一件事，不会又弹回来
  await page.getByTestId('simple-leftover').click();
  await expect(page.getByTestId('simple-leftover-note')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('simple-leftover-done').click();
  await expect(page.getByTestId('simple-leftover-note')).toBeHidden();
  await expect(page.getByTestId('simple-recommend')).toBeVisible();
  // 库里的晚餐仍是已定的那顿留量餐（收掉的只是屏幕上的这一句说明）
  expect((await bookingSnapshot(page, dinner)).leftoverOf).toBe(lunch);
});

/**
 * 「入口可用与否由服务端下发」这条纪律在 C 上也成立：午餐没标留量时，C 不给大按钮。
 *
 * 反例会让「前端自己拼晚餐 + 同日午餐已定」的实现看起来像对的（那两种实现都“大概能用”），
 * 所以这一条是上面那条的阴性对照：无来源（服务端下发 null）时 C 不得凭空给出入口。
 * 与 `s4-leftover.spec.ts` 里 A 的那条同构，只是换成 C 的入口——三套视图共享同一条服务端判定。
 */
test('C 长辈小孩极简：午餐没标留量时没有「吃剩的」大按钮（没有可吃剩的）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);
  await switchView(page, 'C');
  const { lunch } = await bookLeftoverLunch(page);
  // 把午餐改成一道都没标留量：服务端下发的 leftoverSource 变成 null
  const rewritten = await page.request.put(`${ROOT_URL}/api/slots/${lunch}`, {
    data: { diners: [...ALL_MEMBERS], dishes: [{ recipeId: 'fanqiechaodan' }] },
  });
  expect(rewritten.ok(), `改午餐失败：HTTP ${rewritten.status()}`).toBe(true);
  expect(
    ((await (await page.request.get(`${ROOT_URL}/api/slots/${lunch}`)).json()) as { slot: SlotJson }).slot
      .leftoverSource,
    '午餐没有留量菜时服务端不该下发来源',
  ).toBeNull();

  await page.reload();
  await expect(page.getByTestId('simple-view')).toBeVisible();
  // 晚餐还是未定的（大按钮本来会出现在这一屏），但来源没了就不给入口——要挑菜走「自己挑菜」
  await expect(page.getByTestId('simple-leftover')).toBeHidden();
  await expect(page.getByTestId('simple-manual')).toBeVisible();
});

test('B 掌勺者紧凑流：按天时间轴、行内展开看到份量与留量、可直接取消（S9）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  // 先造一桌已定的菜：荤菜标留量——留量标记要能在这套视图里看见
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: {
      diners: ['mom', 'dad', 'dabao', 'xiaobao'],
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }, { recipeId: 'dongguapaigutang' }],
    },
  });
  expect(booked.ok()).toBe(true);

  await page.goto(`${ROOT_URL}/`);
  await switchView(page, 'B');

  const view = page.getByTestId('compact-view');
  await expect(view).toBeVisible();
  // 按天分组：窗口内每天一个日头
  await expect(view.locator('[data-testid^="compact-day-"]').first()).toBeVisible();

  // 行头已经看得见菜名与留量的月亮；克数在行内展开后（手机首屏只放得下这些）
  const row = page.getByTestId(`compact-slot-${slotId}`);
  await expect(row).toContainText('红烧排骨');
  await expect(row).toContainText('🌙');
  await page.getByTestId(`compact-toggle-${slotId}`).click();
  const body = page.getByTestId(`compact-body-${slotId}`);
  await expect(body).toBeVisible();
  await expect(page.getByTestId(`compact-dish-${slotId}-hongshaopaigu`)).toContainText('留量');
  await expect(page.getByTestId(`compact-dish-${slotId}-hongshaopaigu`)).toContainText(/\d+ g/);
  // 用餐者名单也看得见（改餐前的核对）
  await expect(body).toContainText('妈妈');

  // 手机宽度（总纲「手机优先」）
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  // 直接取消这一餐：与编辑器里的「取消这一餐」同一语义（回到未定）
  await page.getByTestId(`compact-cancel-${slotId}`).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
      const { slot } = (await response.json()) as { slot: SlotJson };
      return slot.status;
    }, { timeout: 15_000 })
    .toBe('undecided');
  // 行变成未定：出现「定一餐」的入口（取消不是封禁，只是退回未定）
  await expect(page.getByTestId(`compact-slot-${slotId}`)).toContainText('未定');
  await expect(page.getByTestId(`compact-book-${slotId}`)).toBeVisible();
});

test('C 长辈小孩极简：两步向导——谁吃 → 吃这些（可换单道）→ 就这么吃（S9）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);

  await page.goto(`${ROOT_URL}/`);
  await switchView(page, 'C');
  const view = page.getByTestId('simple-view');
  await expect(view).toBeVisible();
  // 一屏一事：主界面只给这一餐的两个大按钮
  await expect(page.getByTestId('simple-recommend')).toBeVisible();
  await expect(page.getByTestId('simple-manual')).toBeVisible();

  // 显式触发（总纲 §2.2）：没点之前不生成；点了先问「谁吃」（第一步向导）
  await page.getByTestId('simple-recommend').click();
  await expect(page.getByTestId('simple-step-diners')).toBeVisible();
  await expect(page.getByTestId('simple-diner-xiaobao')).toHaveAttribute('aria-pressed', 'true');

  // 把小宝去掉（忌口与份量按这份名单算）→ 下一步
  await page.getByTestId('simple-diner-xiaobao').click();
  await expect(page.getByTestId('simple-diner-xiaobao')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('simple-next').click();

  // 第二步：这一餐的菜（fake 确定性那一份），每道一张卡；成功档不标降级
  const review = page.getByTestId('simple-step-review');
  await expect(review).toBeVisible({ timeout: 15_000 });
  const cards = review.locator('[data-testid^="simple-dish-"]');
  await expect.poll(async () => cards.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('simple-degraded')).toBeHidden();

  // 不喜欢其中一道？换一个——与 A/B 同一个候选接口、同一份会话排除
  const firstId = (await cards.first().getAttribute('data-testid'))!.replace('simple-dish-', '');
  await page.getByTestId(`simple-swap-${firstId}`).click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });
  const useCandidate = page.locator('[data-testid^="use-candidate-"]').first();
  const candidateId = (await useCandidate.getAttribute('data-testid'))!.replace('use-candidate-', '');
  await useCandidate.click();
  await expect(page.getByTestId(`simple-dish-${candidateId}`)).toBeVisible();
  await expect(page.getByTestId(`simple-dish-${firstId}`)).toBeHidden();

  // 「整套都换」→ 可撤销回上一套（与 A 的草稿撤销同一语义，草稿不落库）
  await expect(page.getByTestId('simple-undo-set')).toBeHidden();
  await page.getByTestId('simple-replace-set').click();
  await expect(page.getByTestId('simple-undo-set')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('simple-undo-set').click();
  await expect(page.getByTestId('simple-undo-set')).toBeHidden();
  // 撤销回到的是换之前那一份（含刚换过的那道菜）
  await expect(page.getByTestId(`simple-dish-${candidateId}`)).toBeVisible();

  // 就这么吃：落库的是换过的那一份，来源标 recommendation、带 LLM 元数据
  await page.getByTestId('simple-accept').click();
  await expect
    .poll(async () => {
      const response = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
      const { slot } = (await response.json()) as { slot: SlotJson };
      return slot.status;
    }, { timeout: 15_000 })
    .toBe('decided');

  const saved = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot, history } = (await saved.json()) as { slot: SlotJson; history: HistoryJson[] };
  expect(slot.menu?.dishes.map((dish) => dish.recipeId)).toContain(candidateId);
  expect(slot.menu?.dishes.map((dish) => dish.recipeId)).not.toContain(firstId);
  // 谁吃那一步真的决定了名单（小宝不在）
  expect(slot.menu?.diners.map((diner) => diner.memberId)).not.toContain('xiaobao');
  const last = history.at(-1)!;
  expect(last.type).toBe('decide');
  expect(last.source).toBe('recommendation');
  expect(last.llm?.model).toBe(E2E.fakeModel);
  expect(last.llm?.degraded).toBe(false);

  // 回到「一屏一事」：这一餐已定，主界面换成下一件没定的事
  await expect(page.getByTestId('simple-view')).toBeVisible();
  await expect(page.getByTestId(`simple-dish-${candidateId}`)).toBeHidden();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});
