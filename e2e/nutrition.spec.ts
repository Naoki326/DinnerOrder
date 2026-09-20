import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 验收场景（本票）：**每餐营养弹层 + 每道菜食谱弹层**。
 *
 * 用户口径：
 *   ① 餐槽卡上「📊 营养」→ 弹层显示本餐合计（能量 / 蛋白 / 脂肪 / 碳水）；
 *   ② 每道菜行上「食谱」→ 弹层显示 `recipes.steps` 原文 + 食材清单。
 * 两处都照 `SettingsSheet` 的 `mask`/`sheet` 交互：点遮罩收起、`role="dialog"`、
 * `aria-haspopup`/`aria-expanded` 齐全，390 宽不吃穿。
 *
 * 时间基准是真实时钟（webServer 不注入假时钟），餐槽 id 一律现取；
 * 库是多个 spec 共用的 append-only 历史，所以断言只用「相对本次操作」的写法，开工前先清场。
 *
 * ⚠️ 文件名以 `n` 开头排在 `meal.spec.ts`（断言未定餐槽留痕为空）**之后**——本用例会往
 * 窗口内的餐槽里写留痕（定餐），那件事清不掉。既有的若干 spec 都隐含依赖文件名顺序。
 */
interface SlotJson {
  id: string;
  status: 'undecided' | 'decided';
  menu: { dishes: { recipeId: string; name: string }[] } | null;
}

/** 清场：窗口内已定的餐槽全取消（与其余 spec 同口径） */
async function clearDecidedSlots(page: Page, days = 14): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  expect(response.ok()).toBe(true);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
  }
}

/** 窗口内最近的未定餐槽（首页大卡就是它） */
async function nextUndecidedSlot(page: Page): Promise<string> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  const slot = slots.find((item) => item.status === 'undecided');
  if (!slot) throw new Error('窗口内没有未定的餐槽，清场逻辑出问题了');
  return slot.id;
}

/** 把两餐定下来：一餐「🈶 蚝油生菜」（含缺数据的蚝油）+ 一餐「🈶 红烧排骨 + 蒜蓉菜心」 */
async function bookTwoSlots(page: Page): Promise<{ withMissing: string; plain: string }> {
  const first = await nextUndecidedSlot(page);
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${first}`, {
    data: { diners: ['mom', 'dad'], dishes: [{ recipeId: 'haoyoushengcai' }, { recipeId: 'hongshaopaigu' }] },
  });
  expect(booked.ok()).toBe(true);
  return { withMissing: first, plain: first };
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

test('点「📊 营养」弹出整餐营养：显示四项数字、口径与缺数据的食材（不当 0 算）', async ({ page }) => {
  await clearDecidedSlots(page);
  // 蚝油生菜里那味蚝油没有营养数据（成分表查不到），所以这一餐一定带缺口——
  // 拿它当真实样本验「界面会不会把这件事说出来」
  const { withMissing } = await bookTwoSlots(page);

  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('home-view')).toBeVisible();

  // 已定的那一餐从大卡滑到下面的餐槽列表，点进去（编辑器里也有同一个营养入口）
  await page.goto(`${ROOT_URL}/slot/${withMissing}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();

  const button = page.getByTestId('nutrition-button');
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');

  const sheet = page.getByTestId('nutrition-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('role', 'dialog');
  await expect(sheet).toHaveAttribute('aria-label', '这一餐的营养');

  // 真有数字（不是空面板）：能量是个正整数，三项宏量都渲染出来
  const energy = page.getByTestId('nutrition-energy');
  await expect(energy).toBeVisible();
  const energyText = (await energy.textContent()) ?? '';
  const kcal = Number(energyText.match(/(\d+(?:\.\d+)?)/)?.[1]);
  expect(kcal, energyText).toBeGreaterThan(0);
  await expect(page.getByTestId('nutrition-protein')).toContainText('g');
  await expect(page.getByTestId('nutrition-fat')).toContainText('g');
  await expect(page.getByTestId('nutrition-carb')).toContainText('g');

  // 口径说清了是「整餐合计」+「按 N 人算」——不是每人份
  await expect(page.getByTestId('nutrition-scope')).toContainText('这一餐合计');
  await expect(page.getByTestId('nutrition-scope')).toContainText('按 2 人算');

  // 逐道菜的读数也列出来了
  await expect(page.getByTestId('nutrition-dish-haoyoushengcai')).toBeVisible();
  await expect(page.getByTestId('nutrition-dish-hongshaopaigu')).toBeVisible();

  // 缺数据的食材必须说出来（蚝油）：这是本票选的「部分合计 + 明示缺口」口径
  await expect(page.getByTestId('nutrition-missing')).toContainText('蚝油');
  await expect(page.getByTestId('nutrition-missing')).toContainText('偏低');

  // 是估算的说明（界面上如实说：成分表平均值、生重、未计损耗）
  await expect(page.getByTestId('nutrition-note')).toContainText('参考值');

  // 点遮罩收起（`mask` 的 onClick），再点内容区不收起
  await sheet.click({ position: { x: 10, y: 10 } });
  await expect(sheet).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('点菜行的「食谱」弹出做法步骤与食材清单；点内容区不收起', async ({ page }) => {
  await clearDecidedSlots(page);
  const { plain } = await bookTwoSlots(page);

  await page.goto(`${ROOT_URL}/slot/${plain}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();

  const button = page.getByTestId('recipe-hongshaopaigu');
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  await button.click();

  const sheet = page.getByTestId('recipe-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('role', 'dialog');
  await expect(sheet).toHaveAttribute('aria-label', '红烧排骨 的食谱');
  await expect(page.getByTestId('recipe-sheet-title')).toContainText('红烧排骨');

  // 做法步骤原文渲染出来（家庭菜的步骤是自由文本）
  const steps = page.getByTestId('recipe-steps');
  await expect(steps).toBeVisible();
  expect(((await steps.textContent()) ?? '').length).toBeGreaterThan(3);

  // 食材清单：成人份基准 + 本餐生重两列（编辑器里有份量，所以两列都在）
  const ribs = page.getByTestId('recipe-ingredient-pork_ribs');
  await expect(ribs).toContainText('150 g'); // 成人份基准
  await expect(page.getByTestId('recipe-grams-pork_ribs')).toContainText('300 g'); // 两个成人 → 本餐

  // 点内容区不收起（`stopPropagation`）——面板仍然在。点的是面板**内部**的元素：
  // 遮罩铺满全屏但 sheet 贴着底边，点靠近顶部的位置其实落在遮罩上（那就是收起）。
  await page.getByTestId('recipe-body').click();
  await expect(sheet).toBeVisible();

  // 点遮罩收起（贴着顶部的空白就是遮罩）
  await sheet.click({ position: { x: 5, y: 2 } });
  await expect(sheet).toBeHidden();
});

test('大卡上的已定餐：营养按钮与每道菜的食谱入口都在，且不吃手机宽度（390）', async ({ page }) => {
  await clearDecidedSlots(page);
  // 把窗口内的每一餐都定下来：大卡必然落在已定的那一张上（HomeView 的 next 规则）
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots) {
    const booked = await page.request.put(`${ROOT_URL}/api/slots/${slot.id}`, {
      data: { diners: ['mom', 'dad'], dishes: [{ recipeId: 'haoyoushengcai' }, { recipeId: 'hongshaopaigu' }] },
    });
    expect(booked.ok()).toBe(true);
  }

  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('home-view')).toBeVisible();

  // 大卡上的营养按钮与逐道菜的食谱入口
  const nutritionButton = page.getByTestId('hero-nutrition-button');
  await expect(nutritionButton).toBeVisible();
  nutritionButton.click();
  await expect(page.getByTestId('nutrition-sheet')).toBeVisible();
  await expect(page.getByTestId('nutrition-energy')).toContainText('kcal');
  // 遮罩收起
  await page.getByTestId('nutrition-sheet').click({ position: { x: 5, y: 2 } });
  await expect(page.getByTestId('nutrition-sheet')).toBeHidden();

  const recipeButton = page.getByTestId('hero-dish-recipe-hongshaopaigu').first();
  await expect(recipeButton).toBeVisible();
  recipeButton.click();
  await expect(page.getByTestId('recipe-sheet')).toBeVisible();
  await expect(page.getByTestId('recipe-steps')).toBeVisible();

  // 手机宽度（总纲「手机优先」）：弹层打开着也不横向溢出。拿真实渲染宽度对账，
  // 不是只看文档宽度（后者被 body 的 max-width 兜死，改坏面板也照样绿）。
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1);
    return wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
  });
  expect(overflow).toEqual([]);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  // 编辑器一侧（加了「食谱」按钮的菜行）同样不吃手机宽度
  await page.getByTestId('recipe-sheet').click({ position: { x: 5, y: 2 } });
  await page.goto(`${ROOT_URL}/slot/${slots[0]!.id}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();
  const editorOverflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1);
    return wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
  });
  expect(editorOverflow).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
