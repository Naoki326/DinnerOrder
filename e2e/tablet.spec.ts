import { expect, test, type Page } from '@playwright/test';
import { bookingSnapshot, clearDecidedSlots, type SlotJson } from './probes';
import { ROOT_URL, E2E } from './test-env';

/**
 * 验收场景 S11 版式（#31）：与「当前身份」「视图模式」同级的**设备本地偏好**，
 * 与视图模式**正交**（视图模式决定用哪一套界面 A/B/C，版式决定这一套摆成几列）。
 *
 * 判据只有一处：视口宽度 ≥ `TABLET_MIN_WIDTH`（900）走平板版，否则手机版；设置里可以手动
 * 覆盖成「手机版 / 平板版」（手动比宽度优先）。`app-shell` 上的 `data-layout` 是判定
 * **当前版式**的唯一锚点（页面里一律读它，不各自调 `matchMedia`）。
 *
 * 这一份 spec 在 `phone` 与 `tablet` 两个 project 下都会跑（见 `playwright.config.ts`）：
 * 凡与尺寸无关的行为用中立断言（`data-layout` 与视口比、导航按语义名找），
 * 只在确实要「某一种版式」时才临时改视口或开新上下文。
 */
const TABLET_VIEWPORT = E2E.tabletViewport;
const PHONE_VIEWPORT = E2E.viewport;

/** 打开设置（产品里的入口），等面板上屏 */
async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
}

/**
 * 收起设置面板。设置遮罩会拦住齿轮与导航（这正是 story 44/45 要的），所以收起要么点遮罩、
 * 要么点选项本身——都是产品里真有的动作。
 */
async function closeSettings(page: Page): Promise<void> {
  await page.getByTestId('settings-sheet').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('settings-sheet')).toBeHidden();
}

/** 在设置里选一种版式（面板**不**收起：要能接着看「此刻生效」那一行） */
async function chooseLayout(page: Page, preference: 'auto' | 'phone' | 'tablet'): Promise<void> {
  await page.getByTestId(`layout-option-${preference}`).click();
  await expect(page.getByTestId(`layout-option-${preference}`)).toHaveAttribute('aria-pressed', 'true');
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

/**
 * 故事 1 / 2 / 3：版式判据是**视口宽度**。
 *
 * 宽度 → 版式的关系用 `data-layout` 与当前视口比，而不是写死「平板 project 就该 wide」：
 * 这样这条断言在 `phone` 与 `tablet` 两个 project 下都是**真的检查**，不会在一侧变成空断言。
 */
test('版式自动跟着视口宽度：≥ 900px 是平板版（侧边导航），否则是手机版（底部胶囊）', async ({ page }) => {
  await page.goto(`${ROOT_URL}/`);
  const expected = page.viewportSize()!.width >= E2E.tabletMinWidth ? 'wide' : 'narrow';

  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', expected);
  if (expected === 'wide') {
    await expect(page.getByTestId('side-nav')).toBeVisible();
    await expect(page.getByTestId('tab-bar')).toHaveCount(0);
  } else {
    await expect(page.getByTestId('tab-bar')).toBeVisible();
    await expect(page.getByTestId('side-nav')).toHaveCount(0);
  }
  // 四个日常页入口两种版式下都在（只是形态不同）
  await expect(page.getByTestId('main-nav')).toHaveCount(4);
});

/** 故事 10：**自动**状态下拖动窗口跨过阈值，版式跟着变，不刷新（验 `matchMedia` 订阅） */
test('自动版式跨过阈值即时切换（不刷新）', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('side-nav')).toBeVisible();

  // 缩到手机宽度：导航形态跟着换（有订阅才可能）
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'narrow');
  await expect(page.getByTestId('tab-bar')).toBeVisible();
  await expect(page.getByTestId('side-nav')).toHaveCount(0);

  // 再放大回来：切回平板版
  await page.setViewportSize(TABLET_VIEWPORT);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('side-nav')).toBeVisible();
});

/** 故事 4 / 5 / 6：手动覆盖优先于宽度，且能退回自动 */
test('设置里手动选「手机版 / 平板版」优先于屏幕宽度，选「自动」后重新跟宽度走', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);
  await openSettings(page);

  // 三选一都在，默认「自动」
  for (const id of ['auto', 'phone', 'tablet'] as const) {
    await expect(page.getByTestId(`layout-option-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('layout-option-auto')).toHaveAttribute('aria-pressed', 'true');

  // 手动「手机版」：视口保持 1024，仍是窄版（故事 4）
  await chooseLayout(page, 'phone');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'narrow');
  await closeSettings(page);
  await expect(page.getByTestId('tab-bar')).toBeVisible();

  // 手动「平板版」：缩到 700 仍是宽版（故事 5）
  await openSettings(page);
  await chooseLayout(page, 'tablet');
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('side-nav')).toBeVisible();

  // 退回「自动」：又跟着宽度走（故事 6）——此刻 700 → narrow，放大 → wide
  await chooseLayout(page, 'auto');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'narrow');
  await page.setViewportSize(TABLET_VIEWPORT);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
});

/** 故事 7 / 8：刷新仍在（设备本地持久）＋ 不跨设备（另一台默认自动） */
test('版式是设备本地设置：刷新仍在，且不跨设备共享', async ({ page, browser }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'narrow');

  // 手动钉成平板版
  await openSettings(page);
  await chooseLayout(page, 'tablet');
  await closeSettings(page);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');

  // 刷新仍在（它不进画像、不上服务端，只能是设备本地的）
  await page.reload();
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('side-nav')).toBeVisible();

  // 不跨设备：另一台（默认自动 + 手机宽度）打开仍是窄版
  const other = await browser.newContext({ viewport: PHONE_VIEWPORT });
  const otherPage = await other.newPage();
  await otherPage.goto(`${ROOT_URL}/`);
  await expect(otherPage.getByTestId('app-shell')).toHaveAttribute('data-layout', 'narrow');
  await other.close();
});

/** 故事 9：设置里看得出「此刻生效的是哪一种」，而不是只能猜 */
test('设置面板显示此刻生效的版式', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);
  await openSettings(page);

  // 自动 + 1024：此刻是平板版，并把判据写清（阈值从 E2E 那份镜像常量来，不写死一个数字）
  await expect(page.getByTestId('layout-effective')).toContainText('此刻生效：平板版');
  await expect(page.getByTestId('layout-effective')).toContainText('自动');
  await expect(page.getByTestId('layout-effective')).toContainText(String(E2E.tabletMinWidth));

  // 手动选「手机版」：同一个读数立刻跟着变成手机版
  await chooseLayout(page, 'phone');
  await expect(page.getByTestId('layout-effective')).toContainText('此刻生效：手机版');
});

/** 故事 11–16：平板版侧边导航可用，当前页有选中态 */
test('平板版侧边导航：四个入口可达、当前页有选中态', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);

  const nav = page.getByTestId('side-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: /今天/ })).toHaveAttribute('aria-current', 'page');

  // 「买菜」→ /grocery（与手机底部胶囊同一语义），到了那边「买菜」是当前页
  await nav.getByRole('link', { name: /买菜/ }).click();
  await expect(page).toHaveURL(`${ROOT_URL}/grocery`);
  await expect(nav.getByRole('link', { name: /买菜/ })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: /今天/ })).not.toHaveAttribute('aria-current', 'page');

  // 「今天」→ 回首页
  await nav.getByRole('link', { name: /今天/ }).click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  await expect(page.getByTestId('side-nav').getByRole('link', { name: /今天/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

/**
 * 故事 43 / 44 / 45：平板版弹层居中弹出、遮罩盖住导航（导航点不动）。
 *
 * 「被遮罩盖住」的判定用**几何重叠**：遮罩铺满视口，而侧边导航在它底下——
 * 点击落在遮罩上（导航拿不到点击）。这里断言遮罩矩形覆盖导航矩形，且点导航位置**不会**离开当前页。
 */
test('平板版弹层：居中弹出、遮罩盖住侧边导航（点导航不生效）', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);
  await openSettings(page);

  const mask = page.getByTestId('settings-sheet');
  const sheet = mask.locator('> div');
  const nav = page.getByTestId('side-nav');
  const maskBox = (await mask.boundingBox())!;
  const sheetBox = (await sheet.boundingBox())!;
  const navBox = (await nav.boundingBox())!;

  // 遮罩铺满视口，把导航整个盖住（story 44）
  const viewport = page.viewportSize()!;
  expect(maskBox.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(maskBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
  expect(maskBox.x).toBeLessThanOrEqual(navBox.x);
  expect(maskBox.y).toBeLessThanOrEqual(navBox.y);

  // 居中而不是贴底（story 43）：面板上下留白都不小于 40px
  expect(sheetBox.y).toBeGreaterThan(40);
  expect(viewport.height - (sheetBox.y + sheetBox.height)).toBeGreaterThan(40);

  // 点侧边导航所在的位置：命中的是遮罩 → 面板收起、页面没跳走（story 45）
  await page.mouse.click(navBox.x + navBox.width / 2, Math.min(navBox.y + 60, navBox.y + navBox.height / 2));
  await expect(mask).toBeHidden();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
});

/** 故事 18：菜谱库（从属页）在平板版下**不显示主导航**（也没有某一页被高亮） */
test('菜谱库在平板版下不显示主导航，但有「← 设置」返回', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/recipes`);

  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('recipe-library-view')).toBeVisible();
  await expect(page.getByTestId('main-nav')).toHaveCount(0);
  await expect(page.getByTestId('side-nav')).toHaveCount(0);
  await expect(page.getByTestId('recipe-back-settings')).toBeVisible();
});

/** 故事 19 / 47：手机版那一套一行不改（底部胶囊、抽屉式弹层） */
test('手机宽度下：底部胶囊导航照旧，弹层仍是底部抽屉', async ({ page }) => {
  await page.setViewportSize(PHONE_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('tab-bar')).toBeVisible();
  await expect(page.getByTestId('side-nav')).toHaveCount(0);

  await openSettings(page);
  const viewport = page.viewportSize()!;
  const sheetBox = (await page.getByTestId('settings-sheet').locator('> div').boundingBox())!;
  // 抽屉贴底：面板下沿就是视口下沿
  expect(viewport.height - (sheetBox.y + sheetBox.height)).toBeLessThanOrEqual(1);
});

/** 故事 20–23：平板版首页——左列餐槽时间轴 + 右列选中餐详情 */
test('平板版首页：左列餐槽时间轴可点，右列显示选中那一餐的详情与操作', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);

  await expect(page.getByTestId('slot-timeline')).toBeVisible();
  // 时间轴包含窗口里**全部**餐槽（含已定的），不只是「最近未定」那一张
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  await expect(page.locator('[data-testid^="timeline-slot-"]')).toHaveCount(slots.length);

  // 每格有摘要（已定列菜名、未定说一句实情）——不用逐张点开
  const undecided = slots.find((slot) => slot.status === 'undecided');
  if (undecided) {
    await expect(page.getByTestId(`timeline-summary-${undecided.id}`)).toContainText('还没定');
  }

  // 点其中一格：右列换成那一餐（右列就是手机版的大卡，testid 不变）
  const first = slots[0]!;
  await page.getByTestId(`timeline-slot-${first.id}`).click();
  await expect(page.getByTestId('empty-slot')).toHaveAttribute('data-slot-id', first.id);
  // 操作入口就在右列，不用跳页（故事 22）
  await expect(page.getByTestId('recommend-button')).toBeVisible();
  await expect(page.locator('[data-testid="book-slot-button"], [data-testid="edit-slot-button"]')).toBeVisible();
});

/** 故事 26 / 27 / 28：宽版首页的空态与回声都还在 */
test('平板版首页：没有餐槽时的空态与手机版一致', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await clearDecidedSlots(page);
  // 把窗口内每一餐都定掉：首页就没有「未定餐槽」，但餐槽本身还在（时间轴照列）
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots) {
    await page.request.put(`${ROOT_URL}/api/slots/${slot.id}`, {
      data: { diners: ['mom', 'dad'], dishes: [{ recipeId: 'fanqiechaodan' }] },
    });
  }
  await page.goto(`${ROOT_URL}/`);
  // 时间轴还在、每格都是「已定」+ 菜名摘要（不是一片空白）
  await expect(page.getByTestId('slot-timeline')).toBeVisible();
  await expect(page.getByTestId(`timeline-summary-${slots[0]!.id}`)).toContainText('番茄炒蛋');
  // 右列仍然给得出操作入口（推荐 / 改这餐）
  await expect(page.getByTestId('recommend-button')).toBeVisible();
});

/**
 * 故事 48：跨版式语义一致——同一个「定一餐」流程在手机版与平板版各走一遍，
 * 服务端快照逐字段相同。
 *
 * **直接复用 `views.spec.ts` 的 `bookingSnapshot()` 探针**（issue #31 的 Testing Decisions 明写）：
 * 它已经断状态、菜品（含每道留量）、名单、留量引用、逐菜上浮与末条留痕的类型/source/LLM
 * 语义字段——两岸各抄一份必在字段上漂移（抄的那份已经漏过两个字段）。
 */
test('跨版式语义一致：同一条「定一餐」在手机版与平板版的服务端结果逐字段相同', async ({ browser }) => {
  const snapshots: Record<'phone' | 'tablet', string | undefined> = { phone: undefined, tablet: undefined };
  let slotId = '';

  for (const variant of ['phone', 'tablet'] as const) {
    const context = await browser.newContext({
      viewport: variant === 'tablet' ? TABLET_VIEWPORT : PHONE_VIEWPORT,
    });
    const page = await context.newPage();
    await page.goto(`${ROOT_URL}/`);
    await clearDecidedSlots(page);

    const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
    const { slots } = (await response.json()) as { slots: SlotJson[] };
    const slot = slots.find((item) => item.status === 'undecided')!;
    slotId = slot.id;

    // 两条路都是产品里的入口：宽版右列的大卡就是手机版那张卡，所以同一个「给我推荐 → 就这一套」
    await expect(page.getByTestId('app-shell')).toHaveAttribute(
      'data-layout',
      variant === 'tablet' ? 'wide' : 'narrow',
    );
    if (variant === 'tablet') {
      await page.getByTestId(`timeline-slot-${slot.id}`).click();
      await expect(page.getByTestId('empty-slot')).toHaveAttribute('data-slot-id', slot.id);
    }
    await page.getByTestId('recommend-button').click();
    const panel = page.getByTestId('recommendation-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('accept-recommendation').click();
    await expect(panel).toBeHidden();

    await expect
      .poll(async () => {
        const res = await page.request.get(`${ROOT_URL}/api/slots/${slot.id}`);
        const { slot: current } = (await res.json()) as { slot: SlotJson };
        return current.status;
      }, { timeout: 15_000 })
      .toBe('decided');

    // 服务端快照：**复用 `views.spec.ts` 的 `bookingSnapshot()` 探针**（issue #31 的
    // Testing Decisions 明写「直接复用」，不另写一份）——它已经覆盖状态、菜品（含每道留量）、
    // 名单、留量引用、逐菜上浮、末条留痕的类型/source/LLM 语义字段。
    snapshots[variant] = JSON.stringify(await bookingSnapshot(page, slot.id));
    await context.close();
  }

  expect(slotId).not.toBe('');
  expect(snapshots.tablet, '平板版与手机版的服务端结果必须逐字段相同').toBe(snapshots.phone);
});

/**
 * 故事 29–42：六页在平板版下**打开得了、关键入口在、不横向溢出**。
 *
 * 刻意只做这一层的冒烟：核心操作的完整覆盖由既有的各条 spec 在 `phone` project 承担
 * （`#31` 明写不要把那 95 条断言整体复制到宽版）。这里每页一条，防的是「宽版某一页直接把
 * 布局摆崩了」这类回归。
 */
test('平板版逐页冒烟：六页打开得了、关键入口在、不横向溢出', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await clearDecidedSlots(page);
  const viewport = page.viewportSize()!;
  const noOverflow = async (label: string): Promise<void> => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth, `${label} 不该横向溢出`).toBeLessThanOrEqual(viewport.width);
  };

  // 首页
  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('slot-timeline')).toBeVisible();
  await noOverflow('首页');

  // 买菜清单（勾选区 + 汇总区双列；手工行恒在）
  await page.getByTestId('side-nav').getByRole('link', { name: /买菜/ }).click();
  await expect(page.getByTestId('grocery-view')).toBeVisible();
  await expect(page.getByTestId('grocery-view')).toHaveAttribute('data-layout-view', 'wide');
  await expect(page.getByTestId('grocery-manual')).toBeVisible();
  await expect(page.getByTestId('grocery-manual-input')).toBeVisible();
  await noOverflow('买菜清单');

  // 餐后回顾（左餐次列表 / 右反馈详情）
  await page.getByTestId('side-nav').getByRole('link', { name: /回顾/ }).click();
  await expect(page.getByTestId('review-view')).toBeVisible();
  await expect(page.getByTestId('review-view')).toHaveAttribute('data-layout-view', 'wide');
  await noOverflow('餐后回顾');

  // 家人（卡片网格；新增入口在）
  await page.getByTestId('side-nav').getByRole('link', { name: /家人/ }).click();
  await expect(page.getByTestId('family-view')).toBeVisible();
  await expect(page.getByTestId('add-member')).toBeVisible();
  await noOverflow('家人');

  // 定餐编辑器（左挑菜 / 右份量与用餐者）
  const slotsResponse = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await slotsResponse.json()) as { slots: SlotJson[] };
  const slot = slots.find((item) => item.status === 'undecided') ?? slots[0]!;
  await page.goto(`${ROOT_URL}/slot/${slot.id}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();
  await expect(page.getByTestId('slot-view')).toHaveAttribute('data-layout-view', 'wide');
  await expect(page.getByTestId('diner-picker')).toBeVisible();
  await expect(page.getByTestId('save-slot')).toBeVisible();
  await noOverflow('定餐编辑器');

  // 菜谱库（从属页：列表在左、详情在右；主导航不显示）
  await page.goto(`${ROOT_URL}/recipes`);
  await expect(page.getByTestId('recipe-library-view')).toBeVisible();
  await expect(page.getByTestId('recipe-library-view')).toHaveAttribute('data-layout-view', 'wide');
  await expect(page.getByTestId('recipe-search-input')).toBeVisible();
  await expect(page.getByTestId('recipe-detail-empty')).toBeVisible();
  await expect(page.getByTestId('main-nav')).toHaveCount(0);
  await noOverflow('菜谱库');
});

/** 故事 49 / 50：平板版下 A/B/C 三套视图都能用，且都走同一份数据 */
test('平板版下 A/B/C 三套视图都能用，各自变成宽屏摆法', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);

  // 默认 A：宽版首页（时间轴 + 详情）
  await expect(page.getByTestId('home-view')).toBeVisible();
  await expect(page.getByTestId('slot-timeline')).toBeVisible();

  for (const mode of ['B', 'C'] as const) {
    await openSettings(page);
    await page.getByTestId(`view-mode-option-${mode}`).click();
    await expect(page.getByTestId('settings-sheet')).toBeHidden();
    const testId = mode === 'B' ? 'compact-view' : 'simple-view';
    await expect(page.getByTestId(testId)).toBeVisible();
    // 版式仍是平板版：导航没变（视图模式与版式正交，story 49）
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
    await expect(page.getByTestId('side-nav')).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
  }

  // 回到 A
  await openSettings(page);
  await page.getByTestId('view-mode-option-A').click();
  await expect(page.getByTestId('home-view')).toBeVisible();
});

/**
 * 故事 51 / 53：两个偏好互不干扰——手机上把视图模式切成 B，平板上打开仍是平板版 +
 * **该设备自己的**视图模式；切走再切回来不残留状态。
 */
test('版式与视图模式互不干扰：切到手机版再回自动，平板摆法立刻回来', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.goto(`${ROOT_URL}/`);

  await openSettings(page);
  await chooseLayout(page, 'phone');
  // 手机版：宽版首页不在、底部胶囊在（故事 53 的前半）
  await expect(page.getByTestId('tab-bar')).toBeVisible();
  await expect(page.getByTestId('slot-timeline')).toHaveCount(0);

  await chooseLayout(page, 'auto');
  // 回到自动：立刻回到平板摆法，不残留上一套
  await expect(page.getByTestId('side-nav')).toBeVisible();
  await expect(page.getByTestId('slot-timeline')).toBeVisible();
});

/** 故事 57：`matchMedia` 不可用时降级为手机版，而不是白屏 */
test('matchMedia 不可用时降级为手机版（不白屏）', async ({ page }) => {
  await page.setViewportSize(TABLET_VIEWPORT);
  await page.addInitScript(() => {
    // 模拟旧浏览器/隐私模式：接口直接不在
    // @ts-expect-error 有意删掉这个 API
    delete window.matchMedia;
  });
  await page.goto(`${ROOT_URL}/`);

  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'narrow');
  await expect(page.getByTestId('tab-bar')).toBeVisible();
  // 界面照常可用（不是白屏）
  await expect(page.getByTestId('home-view')).toBeVisible();
});

/** 故事 58：localStorage 不可用（抛异常）时版式偏好在本次会话内仍然生效，界面不报错 */
test('localStorage 不可用时版式偏好当次仍然生效（界面不报错）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 700, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    // 读写都抛：模拟隐私模式下的 quota/security 异常
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage is disabled');
      },
    });
  });
  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'narrow');

  // 手动选平板版：写不进 localStorage，但**本次会话内**必须立刻生效
  await openSettings(page);
  await chooseLayout(page, 'tablet');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByTestId('side-nav')).toBeVisible();
  await expect(page.getByTestId('layout-effective')).toContainText('此刻生效：平板版');

  await context.close();
});
