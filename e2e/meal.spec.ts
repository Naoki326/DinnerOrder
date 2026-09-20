import { expect, test, type Page } from '@playwright/test';
import { E2E, ROOT_URL } from './test-env';
/**
 * 验收场景（本票部分）：不靠推荐、纯手动打通「定一餐」——
 * 打开 app 见最近未定餐槽 → 进定餐编辑器 → 挑家庭菜谱组成菜单 → 保存为已定 → 可取消；
 * 菜单每次变化追加一条不可变留痕，历史可查（总纲 §2.1、§2.8；ADR-0007）。
 *
 * 测试会改库，所以开工前先把窗口内的已定餐槽全取消掉：先复原再断言，不依赖测试执行顺序。
 * 时间基准是真实时钟（E2E 的 webServer 不注入假时钟），餐槽日期因此不能写死——
 * 一律从 `/api/slots` 现取。
 */
interface SlotJson {
  id: string;
  status: 'undecided' | 'decided';
  menu: { dishes: { name: string; keepLeftover: boolean }[] } | null;
}

/** 清场：把窗口内已定的餐槽都取消，让「最近未定餐槽」一定是干净的一张空卡 */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  expect(response.ok()).toBe(true);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    expect(cancelled.ok()).toBe(true);
  }
}

async function slotState(page: Page, id: string): Promise<SlotJson> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${id}`);
  expect(response.ok()).toBe(true);
  const { slot } = (await response.json()) as { slot: SlotJson };
  return slot;
}

/**
 * 每个测试收尾都把窗口内的已定餐槽取消掉：
 * 冒烟测试（smoke.spec）共用同一个库，它断言的是首屏那张「最近未定餐槽」大卡——
 * 留一份已定的菜单在那里，下一条测试看到的就不是未定态了。
 *
 * ⚠️ **留痕是 append-only，历史事件永不删除**（ADR-0007），所以这些测试只能做
 * 「相对本次操作」的断言，不能假设历史从零开始（历史会随毎一轮 E2E 累积）。
 */
test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

/**
 * 本次「定一餐→改→取消」会产生的事件类型序列，取最后 n 条。
 * 历史不断累积，所以断言的是**尾部**（本次新增的那些），而不是全集。
 */
async function historyTail(page: Page, id: string, n: number): Promise<string[]> {
  const history = await slotHistory(page, id);
  return history.slice(-n).map((event) => event.type);
}

/** 历史里某类事件的条数（append-only，历史会随多轮 E2E 累积） */
function countOf(history: { type: string }[], type: string): number {
  return history.filter((event) => event.type === type).length;
}

async function slotHistory(page: Page, id: string): Promise<{ type: string }[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${id}`);
  const { history } = (await response.json()) as { history: { type: string }[] };
  return history;
}

/**
 * 餐槽列表里的「幽灵卡」是 `<Link>` 渲染的 `<a>`。全局 `.card` 只声明背景/内边距/
 * margin、不声明 `display`，于是 `<a>` 保持浏览器默认的 `display: inline`，
 * `margin: 10px 12px` 的水平内缩在 inline 元素上算不出来，卡片会撑满视口
 * （rect.x=0、width=390），卡片内的文字被左侧虚线边框压住。
 *
 * 这里钉住「餐槽卡不吃穿容器」：x 必须有左内缩（>0）、宽度必须小于视口宽。
 * 只断言可见是抓不住这个 bug 的（塌陷的卡片照样可见）。
 */
test('餐槽列表的幽灵卡不越界：有左内缩且宽度小于视口', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);

  const ghost = page.getByTestId('ghost-slot').first();
  await expect(ghost).toBeVisible();

  // 该卡是 <a>：display 若塌成 inline，水平 margin 就不生效（本 bug 的根因）
  const display = await ghost.evaluate((el) => getComputedStyle(el).display);
  expect(display).not.toBe('inline');

  const box = await ghost.boundingBox();
  if (!box) throw new Error('幽灵卡没有布局盒');
  // 视口 390 宽 - 两侧各 12px margin = 366；只断言「有内缩且小于视口」
  expect(box.x).toBeGreaterThan(0);
  expect(box.width).toBeLessThan(E2E.viewport.width);
});

test('打开首页见最近未定餐槽大卡，点进去手动定一餐（挑菜 / 改用餐者 / 留量）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);

  // 首屏即见最近的未定餐槽大卡（总纲 §2.1「下一餐优先」）
  const hero = page.getByTestId('empty-slot');
  await expect(hero).toBeVisible();
  await expect(page.getByTestId('book-slot-button')).toBeVisible();

  // 往下还有后面的餐槽卡（每天至多午/晚两卡）
  await expect(page.getByTestId('ghost-slot').first()).toBeVisible();

  const targetId = await hero.getAttribute('data-slot-id');
  expect(targetId).toMatch(/^\d{4}-\d{2}-\d{2}:(lunch|dinner)$/);
  if (!targetId) throw new Error('大卡上没有餐槽 id');

  // 进定餐编辑器
  await page.getByTestId('book-slot-button').click();
  await expect(page).toHaveURL(`${ROOT_URL}/slot/${targetId}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();
  await expect(page.getByTestId('slot-status')).toHaveText('未定');
  await expect(page.getByTestId('history-empty')).toBeVisible();

  // 默认用餐者是全员（总纲 §3）；临时改一次名单：去掉小宝（今天不在家）
  await expect(page.getByTestId('diner-mom')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('diner-xiaobao').click();
  await expect(page.getByTestId('diner-xiaobao')).toHaveAttribute('aria-pressed', 'false');

  // 从家庭菜谱里挑菜：一荤一素一汤（挑菜器按荤/素/汤分组）。加菜器**默认收起**（#29）：
  // 先展开——这也是加菜按钮唯一的新前置动作，收起只省地方、不动任何已选状态。
  await expect(page.getByTestId('no-dishes')).toBeVisible();
  await page.getByTestId('dish-picker-toggle').click();
  await expect(page.getByTestId('dish-picker-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('pick-hongshaopaigu').click();
  await page.getByTestId('pick-fanqiechaodan').click();
  await page.getByTestId('pick-dongguapaigutang').click();
  await expect(page.getByTestId('chosen-hongshaopaigu')).toBeVisible();
  await expect(page.getByTestId('chosen-fanqiechaodan')).toBeVisible();

  // 单道留量（总纲 §2.6：留量是单道级的——荤菜留，绿叶菜不留）
  await page.getByTestId('keep-hongshaopaigu').click();
  await expect(page.getByTestId('keep-hongshaopaigu')).toHaveAttribute('aria-pressed', 'true');

  // 再点一下去掉一道（挑菜器是同一份状态的开关）
  await page.getByTestId('pick-dongguapaigutang').click();
  await expect(page.getByTestId('chosen-dongguapaigutang')).toBeHidden();

  // 定下来 → 回首页，这一餐变成已定，卡片上看得见菜名
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  const decidedCard = page.locator(`[data-slot-id="${targetId}"]`).first();
  await expect(decidedCard).toContainText('已定');
  await expect(decidedCard).toContainText('红烧排骨');

  // 库里定下来了：菜品与用餐者都落库（小宝被临时去掉了）
  const saved = await slotState(page, targetId);
  expect(saved.status).toBe('decided');
  expect(saved.menu?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨', '番茄炒蛋']);
  expect(saved.menu?.dishes[0]?.keepLeftover).toBe(true);

  const history = await slotHistory(page, targetId);
  expect(history.map((event) => event.type)).toContain('decide');
  expect(history[history.length - 1]?.type).toBe('decide');
});

test('已定的一餐还能改（改餐留痕与预定分开），留痕在编辑器里可查', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotsResponse = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  const { slots } = (await slotsResponse.json()) as { slots: SlotJson[] };
  const targetId = slots[0]!.id;

  // 先定一餐（整份菜单一次性提交）
  await page.goto(`${ROOT_URL}/slot/${targetId}`);
  await page.getByTestId('dish-picker-toggle').click();
  await page.getByTestId('pick-hongshaopaigu').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  // 再进去改：加一道素菜（每次重挂编辑器，加菜器又是收起的）
  await page.goto(`${ROOT_URL}/slot/${targetId}`);
  await expect(page.getByTestId('slot-status')).toHaveText('已定');
  const decideBefore = countOf(await slotHistory(page, targetId), 'decide');
  const replaceBefore = countOf(await slotHistory(page, targetId), 'replace');
  await page.getByTestId('dish-picker-toggle').click();
  await page.getByTestId('pick-suanrongcaixin').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  // 留痕：本次新增的是「改餐」而不是又一次「预定」——改餐与预定分开记账。
  // 不写死总数：留痕是 append-only，历史会随多轮 E2E 累积。
  await page.goto(`${ROOT_URL}/slot/${targetId}`);
  expect(await historyTail(page, targetId, 1)).toEqual(['replace']);
  expect(countOf(await slotHistory(page, targetId), 'replace')).toBe(replaceBefore + 1);
  expect(countOf(await slotHistory(page, targetId), 'decide')).toBe(decideBefore);
  // 早先那条「预定」的事实还在（历史不是被覆盖）
  await expect(page.getByTestId('slot-history').getByTestId('history-decide').first()).toBeVisible();
  await expect(page.getByTestId('slot-history').getByTestId('history-replace').last()).toContainText('蒜蓉菜心');
});

test('取消已定的一餐：回到未定、留痕可查、能重新定', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotsResponse = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  const { slots } = (await slotsResponse.json()) as { slots: SlotJson[] };
  const targetId = slots[0]!.id;

  await page.goto(`${ROOT_URL}/slot/${targetId}`);
  await page.getByTestId('dish-picker-toggle').click();
  await page.getByTestId('pick-kelejichi').click();
  await page.getByTestId('pick-fanqiechaodan').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  // 取消：编辑器里的取消按钮（未定的餐槽没有这个按钮）
  await page.goto(`${ROOT_URL}/slot/${targetId}`);
  await page.getByTestId('cancel-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  // 回到未定：菜没了，但历史里本次那两条都在（预定 → 取消）
  await page.goto(`${ROOT_URL}/slot/${targetId}`);
  await expect(page.getByTestId('slot-status')).toHaveText('未定');
  await expect(page.getByTestId('no-dishes')).toBeVisible();
  expect(await historyTail(page, targetId, 2)).toEqual(['decide', 'cancel']);
  // 被取消的那份菜单仍能从事件里读出来（append-only：历史不删）
  await expect(page.getByTestId('slot-history').getByTestId('history-decide-dishes').last()).toContainText('可乐鸡翅');

  expect((await slotState(page, targetId)).status).toBe('undecided');

  // 未定之后还能重新定（取消不是封禁，只是退回未定）
  await page.getByTestId('dish-picker-toggle').click();
  await page.getByTestId('pick-hongshaopaigu').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  expect((await slotState(page, targetId)).status).toBe('decided');
});

test('「最近吃过」走事件流可查（去重窗口），首页不吃手机宽度', async ({ page }) => {
  await page.goto(`${ROOT_URL}/`);

  // 本查询是后续推荐管线的软避让入口，本票先保证它通且形状对
  const response = await page.request.get(`${ROOT_URL}/api/history/recent-dishes?days=7`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { dishes: unknown[] };
  expect(Array.isArray(body.dishes)).toBe(true);

  // 菜谱库按转正态可读（推荐池的唯一来源）
  const recipes = await page.request.get(`${ROOT_URL}/api/recipes`);
  expect(recipes.ok()).toBe(true);
  const { recipes: list } = (await recipes.json()) as { recipes: { name: string; status: string }[] };
  expect(list.length).toBeGreaterThan(0);
  expect(list.every((recipe) => recipe.status === 'active')).toBe(true);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});
