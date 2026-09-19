import { expect, test, type Page } from '@playwright/test';
import { E2E, ROOT_URL } from './test-env';

/**
 * 验收场景 S9（视图模式，总纲 §2.10、spec §8）：
 *  * 视图模式是**设备本地的偏好**（与「当前身份」同级）：设置里三选一，默认 A（下一餐大卡），
 *    刷新仍在、不跨设备共享；
 *  * 原型底部的黑色胶囊「变体切换条」是**评审工具**，不得进产品；
 *  * B（掌勺者紧凑流）与 C（长辈小孩极简）两套视图落地；
 *  * 三套视图**数据模型与操作语义一致**：同一个「定一餐」在任一套视图里走过去，
 *    服务端得到逐字段相同的结果（呈现不同而已）；
 *  * E2E 闭环：先切视图、再走完同一条定餐流程。
 *
 * 时间基准是真实时钟（webServer 不注入假时钟），餐槽 id 一律现取不写死；
 * 留痕 append-only，断言只相对本次操作。
 */
interface SlotJson {
  id: string;
  date: string;
  status: 'undecided' | 'decided';
  menu: {
    dishes: { recipeId: string; name: string; keepLeftover: boolean }[];
    diners: { memberId: string; name: string }[];
  } | null;
}

interface HistoryJson {
  type: string;
  source: string;
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
  lastEvent: string;
  lastSource: string;
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
    lastEvent: last?.type ?? '',
    lastSource: last?.source ?? '',
    lastLlm: last?.llm
      ? { model: last.llm.model, promptVersion: last.llm.promptVersion, degraded: last.llm.degraded }
      : null,
  };
}

/** 全家人（种子的 sort_order）：「不传名单 = 全员」的那一份（总纲 §3、§4） */
const ALL_MEMBERS = ['mom', 'dad', 'dabao', 'xiaobao'] as const;

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
