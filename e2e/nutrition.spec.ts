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

/**
 * 可达性缺口（本票修的 ①）：**下方列表里的已定餐也能打开营养与食谱**。
 *
 * 大卡永远优先显示「最近未定餐槽」（产品意图，不动），所以定完的餐会落到下面的小卡。
 * 这些用例钉住的是「定了明天的餐 → 它进下方列表 → 两个入口仍然在、而且点得开」。
 *
 * ⚠️ 小卡整张是 `<Link>`（`<a>`）：卡内按钮必须 `preventDefault` + `stopPropagation`，
 * 否则点按钮会同时跳进编辑器。所以每条都断言 **URL 不变、编辑器没打开**——只断言
 * 「面板可见」抓不住这个 bug（边跳转边弹面板也会让「面板可见」成立）。
 */
test('下方列表里的已定餐：营养入口点得开、不离开今天页（小卡是 <Link>）', async ({ page }) => {
  await clearDecidedSlots(page);
  // 用 API 定一餐：它必然落在下方列表（大卡让位给下一个未定餐槽）
  const listed = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await listed.json()) as { slots: SlotJson[] };
  const target = slots.find((slot) => slot.status === 'undecided');
  expect(target, '窗口内要有未定餐槽').toBeTruthy();
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${target!.id}`, {
    data: {
      diners: ['mom', 'dad'],
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'kelejichi' }],
    },
  });
  expect(booked.ok()).toBe(true);

  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('home-view')).toBeVisible();

  // 前置成立：这一餐在小卡里（不是大卡）
  const ghost = page.locator(`[data-testid="ghost-slot-decided"][data-slot-id="${target!.id}"]`);
  await expect(ghost).toBeVisible();

  const nutrition = ghost.locator(`[data-testid="ghost-nutrition-${target!.id}"]`);
  await expect(nutrition).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(nutrition).toHaveAttribute('aria-expanded', 'false');
  await nutrition.click();

  // 面板真的开了（不是空壳），并且**没离开今天页**
  await expect(page.getByTestId('nutrition-sheet')).toBeVisible();
  await expect(nutrition).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('nutrition-energy')).toContainText('kcal');
  await expect(page.getByTestId('nutrition-scope')).toContainText('按 2 人算');
  expect(page.url()).toBe(`${ROOT_URL}/`);
  expect(await page.getByTestId('slot-view').count()).toBe(0);

  // 点面板内容区不收起、也不跳走
  await page.getByTestId('nutrition-body').click();
  await expect(page.getByTestId('nutrition-sheet')).toBeVisible();
  expect(page.url()).toBe(`${ROOT_URL}/`);

  // 遮罩收起（贴着顶部的空白就是遮罩）
  await page.getByTestId('nutrition-sheet').click({ position: { x: 5, y: 2 } });
  await expect(page.getByTestId('nutrition-sheet')).toBeHidden();
  expect(page.url()).toBe(`${ROOT_URL}/`);
});

test('下方列表里的已定餐：每道菜的食谱入口点得开、不离开今天页', async ({ page }) => {
  await clearDecidedSlots(page);
  const listed = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await listed.json()) as { slots: SlotJson[] };
  const target = slots.find((slot) => slot.status === 'undecided');
  expect(target, '窗口内要有未定餐槽').toBeTruthy();
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${target!.id}`, {
    data: {
      diners: ['mom', 'dad'],
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'kelejichi' }],
    },
  });
  expect(booked.ok()).toBe(true);

  await page.goto(`${ROOT_URL}/`);
  const ghost = page.locator(`[data-testid="ghost-slot-decided"][data-slot-id="${target!.id}"]`);
  await expect(ghost).toBeVisible();

  // 逐道菜都有入口（不是只给第一道）
  const ribs = ghost.locator('[data-testid="ghost-dish-recipe-hongshaopaigu"]');
  await expect(ribs).toBeVisible();
  await expect(ghost.locator('[data-testid="ghost-dish-recipe-kelejichi"]')).toBeVisible();

  await ribs.click();
  await expect(page.getByTestId('recipe-sheet')).toBeVisible();
  await expect(page.getByTestId('recipe-sheet-title')).toContainText('红烧排骨');
  await expect(page.getByTestId('recipe-steps')).toBeVisible();
  expect(page.url()).toBe(`${ROOT_URL}/`);
  expect(await page.getByTestId('slot-view').count()).toBe(0);

  await page.getByTestId('recipe-sheet').click({ position: { x: 5, y: 2 } });
  await expect(page.getByTestId('recipe-sheet')).toBeHidden();
  expect(page.url()).toBe(`${ROOT_URL}/`);
});

/**
 * 布局 bug（本票修的 ②）：掌勺者那一行含 emoji（👨‍🍳），而 `line-height: normal` 的高度
 * 由**回退字体**决定——字体一换行盒就可能容不下 emoji 的字形，墨迹溢出到行盒外被下方
 * 有背景色的按钮压住。修法是给这些行一个**显式行高**，不再依赖字体回退。
 *
 * 为什么断言「行高是显式值」而不是「两个 boundingBox 不重叠」：本机（Chromium + macOS emoji）
 * 的 `normal` 恰好把行盒撑到 21px，墨迹没真的越界，所以 boundingBox 不重叠这条在**修前也是绿的**
 * （没有判别力，实测过）。真正把 bug 复现条件钉住的是「行高不得是 `normal`／不得由字体回退决定」。
 */
test('掌勺者行有显式行高，不依赖字体回退（emoji 不被下方按钮压住）', async ({ page }) => {
  await clearDecidedSlots(page);
  // 造一张已定餐落在下方列表：大小卡的掌勺者行都要断言
  const listed = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await listed.json()) as { slots: SlotJson[] };
  const target = slots.find((slot) => slot.status === 'undecided');
  expect(target, '窗口内要有未定餐槽').toBeTruthy();
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${target!.id}`, {
    data: { diners: ['mom', 'dad'], dishes: [{ recipeId: 'hongshaopaigu' }] },
  });
  expect(booked.ok()).toBe(true);

  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('home-view')).toBeVisible();

  const rows = [
    page.getByTestId('hero-cook'),
    page.locator(`[data-testid="ghost-cook-${target!.id}"]`),
  ];
  for (const row of rows) {
    await expect(row).toBeVisible();
    // 含 emoji 的行必须是确定行高，不能让 `normal`（字体度量）说了算
    const metrics = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { lineHeight: cs.lineHeight, fontSize: parseFloat(cs.fontSize) };
    });
    expect(metrics.lineHeight, '含 emoji 的掌勺者行不能是 line-height: normal').not.toBe('normal');
    const lineHeight = parseFloat(metrics.lineHeight);
    // 至少 1.5 倍字号：emoji 的字形高度大于同号拉丁/中文字，行盒要留得下它
    expect(lineHeight).toBeGreaterThanOrEqual(metrics.fontSize * 1.5);
  }

  // 大卡上掌勺者行与下方按钮不重叠（行盒层面；真正的判别在上一段的显式行高）
  const heroGap = await page.evaluate(() => {
    const cook = document.querySelector('[data-testid="hero-cook"]')!.getBoundingClientRect();
    const book = document.querySelector('[data-testid="book-slot-button"]')!.getBoundingClientRect();
    return book.top - cook.bottom;
  });
  expect(heroGap).toBeGreaterThanOrEqual(0);
});

/**
 * 布局 bug（本票修的 ③）：「已定」徽标被长菜名预告挤成竖排两行。
 *
 * `.spread` 是 flex 两端对齐，但左侧那一列原先没有 `flex:1`/`min-width:0`，菜名预告一长就把
 * 右侧徽标挤到只剩 36px 宽 → `white-space: normal` 下「已定」上下堆叠。
 *
 * 判别性断言：**徽标里的文字必须只占一个行盒**（`Range.getClientRects()` 长度为 1）。
 * 只看 `badge.width > badge.height` 抓不住——竖排时宽度（36.4）反而略大于高度（36），
 * 实测过（修前也满足）。
 */
test('下方已定小卡的「已定」徽标不被长菜名预告挤成竖排', async ({ page }) => {
  await clearDecidedSlots(page);
  // 三道菜：把菜名预告拉到最长（正是把徽标挤扁的条件）
  const listed = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await listed.json()) as { slots: SlotJson[] };
  const target = slots.find((slot) => slot.status === 'undecided');
  expect(target, '窗口内要有未定餐槽').toBeTruthy();
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${target!.id}`, {
    data: {
      diners: ['mom', 'dad', 'dabao', 'xiaobao'],
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'kelejichi' }, { recipeId: 'qingzhengluyu' }],
    },
  });
  expect(booked.ok()).toBe(true);

  await page.goto(`${ROOT_URL}/`);
  const ghost = page.locator(`[data-testid="ghost-slot-decided"][data-slot-id="${target!.id}"]`);
  await expect(ghost).toBeVisible();
  // 前置成立：预告确实很长（不然这条测试没有压力）
  await expect(ghost).toContainText('红烧排骨');
  await expect(ghost).toContainText(/共 \d+ g/);

  const badge = ghost.locator('.badge');
  await expect(badge).toContainText('已定');

  const measured = await badge.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()];
    const box = el.getBoundingClientRect();
    return {
      textLines: rects.length,
      width: box.width,
      height: box.height,
      whiteSpace: getComputedStyle(el).whiteSpace,
    };
  });
  // 「已定」两个字横排 = 一个行盒；竖排会变成两个
  expect(measured.textLines, '「已定」徽标里的文字必须是横排一行').toBe(1);
  expect(measured.whiteSpace, '徽标不参与换行').toBe('nowrap');
  // 横排的徽标必然矮（竖排时高度会接近宽度）
  expect(measured.height).toBeLessThan(measured.width);

  // 手机宽度：长预告 + 徽标 + 营养入口不撑破 390
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1);
    return wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
  });
  expect(overflow).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
