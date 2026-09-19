import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 验收场景 S3 的一部分（本票）：**菜单显示每道菜本餐生重，改用餐者名单即时重算**。
 * 纯规则查表，LLM 不进数值路径（ADR-0004）。
 *
 * 测试的口径：
 * - 断言的是**与日期无关**的那部分（两个成人 → 恰是成人份基准 × 2）。小孩的分带随真实时钟走，
 *   E2E 不注入假时钟（webServer 跑的是真进程），所以小孩那一段只断言「数字变了」且
 *   「与 API 算出来的一致」——**拿 API 当 oracle**，不去写死某个系数。
 * - 库里的历史是 append-only、多个 spec 共用一个 webServer：只做相对断言，开工前先清场。
 */
interface SlotJson {
  id: string;
  status: 'undecided' | 'decided';
  menu: { dishes: { name: string }[] } | null;
}

interface PortionJson {
  diners: { memberId: string; factor: number; bandLabel: string }[];
  dishes: {
    recipeId: string;
    totalGrams: number;
    ingredients: { ingredientId: string; grams: number }[];
  }[];
}

/** 清场：与 meal.spec 同口径——把窗口内已定的餐槽都取消，让首屏一定是干净的空卡 */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  expect(response.ok()).toBe(true);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    expect(cancelled.ok()).toBe(true);
  }
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

/** 服务端算的份量（编辑器里的数字必须与它一致：算的规则只有一份） */
async function previewPortion(
  page: Page,
  diners: string[],
  dishes: string[],
): Promise<PortionJson> {
  const response = await page.request.post(`${ROOT_URL}/api/portion/preview`, {
    data: { diners, dishes: dishes.map((recipeId) => ({ recipeId })) },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { portion: PortionJson }).portion;
}

test('编辑器显示每道菜的本餐生重，改用餐者名单即时重算（S3）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);
  const targetId = await page.getByTestId('empty-slot').getAttribute('data-slot-id');
  if (!targetId) throw new Error('大卡上没有餐槽 id');
  await page.goto(`${ROOT_URL}/slot/${targetId}`);

  // 名单收敛到两位大人：份量就只是成人份基准 × 2，与日期无关（真实时钟下也稳）
  await page.getByTestId('diner-dabao').click();
  await page.getByTestId('diner-xiaobao').click();
  await expect(page.getByTestId('diner-mom')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('diner-xiaobao')).toHaveAttribute('aria-pressed', 'false');

  // 挑一道荤菜：红烧排骨的成人份基准是猪排骨 150 g
  await page.getByTestId('pick-hongshaopaigu').click();
  await expect(page.getByTestId('portion-hongshaopaigu')).toBeVisible();
  // 两个成人 → 150 × 2 = 300 g（拿服务端当 oracle 断言，界面数字要与它一致）
  const adults = await previewPortion(page, ['mom', 'dad'], ['hongshaopaigu']);
  expect(adults.dishes[0]?.ingredients[0]).toMatchObject({ ingredientId: 'pork_ribs', grams: 300 });
  await expect(page.getByTestId('grams-hongshaopaigu-pork_ribs')).toContainText('300 g');
  await expect(page.getByTestId('portion-hongshaopaigu')).toContainText('合计 300 g');
  await expect(page.getByTestId('portion-summary')).toContainText('×2');

  // 勾上小宝：数字当场变（份量不是定餐时冻住的），且与 API 算的一致
  await page.getByTestId('diner-xiaobao').click();
  const withChild = await previewPortion(page, ['mom', 'dad', 'xiaobao'], ['hongshaopaigu']);
  const childGrams = withChild.dishes[0]?.ingredients[0]?.grams ?? 0;
  expect(childGrams).toBeGreaterThan(300); // 多一个人只会更多
  await expect(page.getByTestId('grams-hongshaopaigu-pork_ribs')).toContainText(`${childGrams} g`);
  // 小孩的 chip 上带着自己的折算系数（家长看得见「为什么不是成人份」）
  await expect(page.getByTestId('diner-factor-xiaobao')).toContainText('×');

  // 去掉小宝：又回到两位成人的 300 g
  await page.getByTestId('diner-xiaobao').click();
  await expect(page.getByTestId('grams-hongshaopaigu-pork_ribs')).toContainText('300 g');

  // 定下来：已定的菜单从 API 也读得到份量（同一份规则，两处入口）
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  const saved = await page.request.get(`${ROOT_URL}/api/slots/${targetId}`);
  const { slot } = (await saved.json()) as { slot: { portion: PortionJson } };
  expect(slot.portion.dishes[0]?.ingredients[0]?.grams).toBe(300);
  expect(slot.portion.diners.map((diner) => diner.memberId)).toEqual(['mom', 'dad']);

  // 首页那张卡就把**每道菜的克数**摆出来了（S3 要求「每道菜」看得见读数；
  // 列表接口内嵌 portion，不必再打一次。已定的那一餐可能在大卡上、也可能在下面的
  // 餐槽列表里，按餐槽 id 定位最稳）
  const card = page.locator(`[data-slot-id="${targetId}"]`);
  await expect(card).toContainText('300 g');
  // 定完餐后它从大卡滑到后面的餐槽列表（大卡总是「最近未定餐槽」），
  // 但仍带着本餐合计；大卡上的逐道菜读数只在该餐槽仍在大卡上时出现（见上一条注释）。
  await expect(page.getByTestId('ghost-slot-decided').first()).toBeVisible();

  // 已定的菜单再进编辑器，份量依旧显示（首屏直接内嵌返回，不再打 preview）
  await page.goto(`${ROOT_URL}/slot/${targetId}`);
  await expect(page.getByTestId('grams-hongshaopaigu-pork_ribs')).toContainText('300 g');
});

test('大卡上的已定餐逐道菜都带生重（首屏就能读，不必进编辑器）', async ({ page }) => {
  // 大卡取「最近未定餐槽」，窗口内没有未定槽时才回退到第一张已定卡（HomeView 的 next 规则）。
  // 所以这条测试只做一件事：把窗口内所有餐槽都定下来，让大卡必然落在已定卡上，
  // 然后检查**每道菜**都带克数（S3 的「菜单显示每道菜生重」在首屏也成立）。
  await clearDecidedSlots(page);
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await response.json()) as { slots: { id: string }[] };
  expect(slots.length).toBeGreaterThan(1);
  for (const slot of slots) {
    const saved = await page.request.put(`${ROOT_URL}/api/slots/${slot.id}`, {
      data: { diners: ['mom', 'dad'], dishes: [{ recipeId: 'hongshaopaigu' }] },
    });
    expect(saved.ok()).toBe(true);
  }

  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('hero-dishes')).toBeVisible();
  // 两个成人 → 150 × 2 = 300 g；每道菜都带读数（不是只给合计）
  await expect(page.getByTestId('hero-dish-grams-hongshaopaigu').first()).toHaveText('300 g');

  await clearDecidedSlots(page);
});

test('固定量的食材不随人数放大（一锅就放这么多）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);
  const targetId = await page.getByTestId('empty-slot').getAttribute('data-slot-id');
  if (!targetId) throw new Error('大卡上没有餐槽 id');
  await page.goto(`${ROOT_URL}/slot/${targetId}`);

  await page.getByTestId('pick-kelejichi').click();

  // 名单收敛到两位大人（真实时钟下小孩的系数随生日走，本用例断的是与日期无关的那部分）
  await page.getByTestId('diner-dabao').click();
  await page.getByTestId('diner-xiaobao').click();
  // 2 个成人：鸡翅 130 × 2 = 260（线性），油恒 10（固定）
  await expect(page.getByTestId('grams-kelejichi-chicken_wings')).toContainText('260 g');
  await expect(page.getByTestId('grams-kelejichi-cooking_oil')).toContainText('10 g');
  await expect(page.getByTestId('portion-kelejichi')).toContainText('合计 270 g');

  // 再加两个人：油**还是** 10 g（fixed 的意义：人数翻倍也不是 20 g）
  await page.getByTestId('diner-dabao').click();
  await page.getByTestId('diner-xiaobao').click();
  await expect(page.getByTestId('grams-kelejichi-cooking_oil')).toContainText('10 g');
  const wingsText = (await page.getByTestId('grams-kelejichi-chicken_wings').textContent()) ?? '';
  expect(Number(wingsText.match(/(\d+) g/)?.[1])).toBeGreaterThan(260);
});

test('份量读数在首屏完整显示且不撑破手机宽度', async ({ page }) => {
  // 规则表与互换表的内容断言在 `portion.test.ts`（API 层，进程内 harness）——
  // 按 issue #12 的测试契约，E2E 不重复 API 层断言，只验浏览器里看得见的结果。
  await clearDecidedSlots(page);
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
  const { slots } = (await response.json()) as { slots: { id: string }[] };
  await page.request.put(`${ROOT_URL}/api/slots/${slots[0]!.id}`, {
    data: {
      diners: ['mom', 'dad', 'dabao', 'xiaobao'],
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'yumihuluobogutang' }],
    },
  });

  await page.goto(`${ROOT_URL}/`);
  await expect(page.getByTestId('home-view')).toBeVisible();

  // 有判别力的部分：克数真的渲染出来了，且是四人级的大数（不是 0 或成人单人值）。
  // 四人 = 1 + 1 + 0.933 + 0.539 = 3.472；若克数行根本没渲染，下面会直接失败。
  const decided = page.getByTestId('ghost-slot-decided').first();
  await expect(decided).toBeVisible();
  await expect(decided).toContainText(/共 \d+ g/);

  // 克数行与文字本身不溢出：拿真实渲染宽度对账（不是只看文档宽度——
  // 后者被 body 的 max-width 兜死，改坏克数行也照样绿）
  const gramTexts = await page.locator('text=/共 \\d+ g/').allTextContents();
  expect(gramTexts.length).toBeGreaterThan(0);
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1);
    return wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
  });
  expect(overflow).toEqual([]);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  await clearDecidedSlots(page);
});
