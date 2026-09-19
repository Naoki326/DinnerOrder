import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 验收场景 S4（本票）：**晚餐预定为「吃剩的」→ 午餐单道留量上浮 → 取消被引用的午餐时联动退回**。
 *
 * 文件名排在 `meal.spec.ts` 之后（按 Playwright 的字典序，`leftover` > `meal`）：那条 spec
 * 断言「未定餐槽的留痕为空」（`history-empty`），而本 spec 会为**午餐**写下留痕。同日午餐在当前
 * 真实时钟下可能正是 meal.spec 拿到的那张「最近未定餐槽」——如果本 spec 先跑，那条断言就会
 * 看到别人留下的留痕。（这是台账记录过的隐含依赖，不是巧合。）
 *
 * 时间基准是真实时钟（E2E 的 webServer 不注入假时钟），所以**餐槽日期一律从 `/api/slots` 现取**，
 * 不写死：这里的做法是先找一张「同日午餐 + 晚餐都在」的日期，用 API 把两餐都定下来走完联动，
 * 再用界面确认读数与提示。
 *
 * ⚠️ 留痕 append-only、多个 spec 共用一个 webServer：只做相对断言，开工前先清场。
 */
interface SlotJson {
  id: string;
  date: string;
  meal: 'lunch' | 'dinner';
  status: 'undecided' | 'decided';
  menu: {
    diners: { memberId: string }[];
    dishes: { name: string; keepLeftover: boolean }[];
    leftoverSlotId: string | null;
  } | null;
  leftoverSource: { slotId: string; dishes: { name: string }[] } | null;
  portion: {
    uplift: number;
    dishes: { recipeId: string; uplift: number; totalGrams: number }[];
  } | null;
}

interface EventJson {
  type: string;
  leftoverSlotId: string | null;
  dishes: { name: string; keepLeftover: boolean }[];
}

/** 清场：与 meal.spec 同口径——把窗口内已定的餐槽都取消，让首屏一定是干净的空卡 */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  expect(response.ok()).toBe(true);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    // 取消被「吃剩的」引用的那一餐会联动把引用方也退回未定（#22），于是那个槽可能已经被
    // 同一次清场里的前一个 DELETE 退回了——那时再取消它是 404，不是失败。
    // 只认「成功」与「本来就没定」两种，其余（网络/500 之类）照旧算失败。
    if (!cancelled.ok()) {
      const body = (await cancelled.json()) as { error?: string };
      expect(body.error, `取消 ${slot.id} 失败`).toBe('not_decided');
    }
  }
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

async function listSlots(page: Page, days = 3): Promise<SlotJson[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { slots: SlotJson[] }).slots;
}

async function getSlot(page: Page, id: string): Promise<{ slot: SlotJson; history: EventJson[] }> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as { slot: SlotJson; history: EventJson[] };
}

async function put(
  page: Page,
  id: string,
  payload: unknown,
): Promise<{ status: number; body: { error?: string; released?: string[] } }> {
  const response = await page.request.put(`${ROOT_URL}/api/slots/${id}`, { data: payload });
  return { status: response.status(), body: (await response.json()) as { error?: string } };
}

/**
 * 找一组「午餐 + 晚餐都还没过截止时刻、且都未定」的同日餐槽。
 * 真实时钟下今天可能只剩晚餐（午餐过了），所以往后看几天，取第一组可用的。
 *
 * ⚠️ 刻意**跳过窗口里的第一张午餐**：那正是 `meal.spec.ts` 会拿到的那张「最近未定餐槽」
 * （它的第一条用例断言 `history-empty`）。本用例会在午餐上写留痕，所以拿更靠后的一组日期，
 * 让两条 spec 碰不到同一个餐槽——这不是洁癖，而是共用一个文件库（webServer 只起一次）的
 * 必然要求。文件名排序（`s4-leftover` > `meal`）只能保证跑的顺序，保不了不踩同一个槽。
 */
async function findLunchDinnerPair(page: Page): Promise<{ lunch: string; dinner: string }> {
  const slots = await listSlots(page, 6);
  const lunches = slots.filter(
    (slot) => slot.meal === 'lunch' && slot.status === 'undecided',
  );
  expect(lunches.length, '窗口内至少要有一张未定的午餐').toBeGreaterThan(1);
  const lunch = lunches[1]!; // 跳过第一张（meal.spec 的地盘）
  const dinner = slots.find((slot) => slot.meal === 'dinner' && slot.date === lunch.date);
  expect(dinner, `${lunch.date} 的晚餐也要在窗口里（吃剩的是当日晚餐）`).toBeTruthy();
  return { lunch: lunch.id, dinner: dinner!.id };
}

/** 定一餐午餐：红烧排骨标留量（成人份 150 g）+ 一道没标留量的素菜 */
async function bookLunchWithKeep(page: Page, lunchId: string): Promise<void> {
  const { status } = await put(page, lunchId, {
    diners: ['mom', 'dad'],
    dishes: [
      { recipeId: 'hongshaopaigu', keepLeftover: true },
      { recipeId: 'suanrongcaixin' },
    ],
  });
  expect(status).toBe(200);
}

test('S4：晚餐吃中午剩的 → 午餐留量上浮 → 取消午餐联动退回（留痕）', async ({ page }) => {
  await clearDecidedSlots(page);
  const { lunch, dinner } = await findLunchDinnerPair(page);

  // 1) 先定午餐，排骨标留量、素菜不标
  await bookLunchWithKeep(page, lunch);

  // 午餐的入口只出现在晚餐那一侧：晚餐现在有可吃剩的（只有标了留量的那一道）
  const before = await getSlot(page, dinner);
  expect(before.slot.leftoverSource?.slotId).toBe(lunch);
  expect(before.slot.leftoverSource?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨']);
  // 午餐自己永远没有这个入口（中午没有可吃剩的上一餐）
  expect((await getSlot(page, lunch)).slot.leftoverSource).toBeNull();

  // 2) 首页大卡直接可点「吃中午剩的」——找到晚餐那张卡（未定的那张就是大卡或列表里的卡）
  await page.goto(`${ROOT_URL}/`);
  // 大卡取「最近未定餐槽」；晚餐是本用例的目标，先确认它露在首页上，再进它的编辑器
  await page.goto(`${ROOT_URL}/slot/${dinner}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();
  await expect(page.getByTestId('leftover-entry')).toBeVisible();
  await page.getByTestId('book-leftover').click();

  // 3) 晚餐落成「吃剩的」：菜从午餐现推导（只有留量的那道），没有自己的菜单快照
  await expect(page.getByTestId('leftover-banner')).toBeVisible();
  const booked = await getSlot(page, dinner);
  expect(booked.slot.status).toBe('decided');
  expect(booked.slot.menu?.leftoverSlotId).toBe(lunch);
  expect(booked.slot.menu?.dishes.map((dish) => dish.name)).toEqual(['红烧排骨']);
  expect(booked.history.at(-1)?.leftoverSlotId).toBe(lunch);

  // 4) 上浮真的生效了：午餐的红烧排骨按 1.5× 算，且晚餐读的是同一个数
  const portionRules = await page.request.get(`${ROOT_URL}/api/portion/rules`);
  const { rules } = (await portionRules.json()) as { rules: { uplift: number } };
  expect(rules.uplift).toBe(1.5);

  const lunchSlot = await getSlot(page, lunch);
  const ribs = lunchSlot.slot.portion?.dishes.find((dish) => dish.recipeId === 'hongshaopaigu');
  expect(ribs?.uplift).toBe(1.5);
  // 素菜没标留量：不上浮（上浮是单道级的）
  expect(lunchSlot.slot.portion?.dishes.find((dish) => dish.recipeId === 'suanrongcaixin')?.uplift).toBe(1);
  // 菜单级读数也是实际生效的那个（界面据此显示倍数）；排骨的读数里带着 1.5
  expect(lunchSlot.slot.portion?.uplift).toBe(1.5);
  expect(ribs?.totalGrams).toBeGreaterThan(0);
  const dinnerSlot = await getSlot(page, dinner);
  expect(dinnerSlot.slot.portion?.uplift).toBe(1.5);
  // 晚餐与午餐读的是同一份算术：同一道菜上浮后的合计，两边算出来是同一个数。
  // 晚餐的名单是它自己那份快照（App 默认全员，可能被别的 spec 改过），拿它现算一份来对齐。
  const dinnerDiners = dinnerSlot.slot.menu?.diners.map((diner) => diner.memberId) ?? [];
  const dinnerPreview = await page.request.post(`${ROOT_URL}/api/portion/preview`, {
    data: {
      diners: dinnerDiners,
      dishes: [{ recipeId: 'hongshaopaigu', keepLeftover: true }],
      slotId: lunch,
    },
  });
  expect(dinnerPreview.ok()).toBe(true);
  const expected = ((await dinnerPreview.json()) as { portion: { dishes: { totalGrams: number }[] } }).portion
    .dishes[0]?.totalGrams;
  expect(dinnerSlot.slot.portion?.dishes[0]?.totalGrams).toBe(expected);

  // 5) 界面上的倍数从 portion.uplift 动态读（不是硬编码的 ×1.5）
  await page.goto(`${ROOT_URL}/slot/${lunch}`);
  await expect(page.getByTestId('portion-summary')).toContainText('留量上浮 1.5');

  // 6) 取消午餐 → 晚餐自动退回未定，并在留痕里留下两条取消
  const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${lunch}`);
  expect(cancelled.ok()).toBe(true);
  const cancelBody = (await cancelled.json()) as { ok: boolean; released: string[] };
  expect(cancelBody.released).toEqual([dinner]);

  const afterDinner = await getSlot(page, dinner);
  expect(afterDinner.slot.status).toBe('undecided');
  expect(afterDinner.slot.menu).toBeNull();
  // 留痕：引用预定 → 联动取消（事件流只增不改）
  expect(afterDinner.history.at(-2)?.leftoverSlotId).toBe(lunch);
  expect(afterDinner.history.at(-1)?.type).toBe('cancel');

  // 上浮随引用一起失效：午餐还留着留量标记，但没上浮了
  await bookLunchWithKeep(page, lunch);
  const relunched = await getSlot(page, lunch);
  expect(relunched.slot.portion?.dishes.find((dish) => dish.recipeId === 'hongshaopaigu')?.uplift).toBe(1);
  expect(relunched.slot.portion?.uplift).toBe(1);

  // 7) 界面上说得清「为什么晚餐退回未定了」（引用失效的提示）
  await page.goto(`${ROOT_URL}/slot/${dinner}`);
  await expect(page.getByTestId('leftover-reverted-notice')).toBeVisible();
  await expect(page.getByTestId('slot-status')).toHaveText('未定');
});

test('S4：从编辑器取消援引的午餐时，首页提示晚餐也一起退回了', async ({ page }) => {
  await clearDecidedSlots(page);
  const { lunch, dinner } = await findLunchDinnerPair(page);
  await bookLunchWithKeep(page, lunch);

  // 晚餐预定成吃剩的（走 API，本用例只验取消时的提示）
  const { status } = await put(page, dinner, { diners: ['mom', 'dad'], dishes: [], leftoverOf: lunch });
  expect(status).toBe(200);

  // 在午餐的编辑器里按「取消这一餐」
  await page.goto(`${ROOT_URL}/slot/${lunch}`);
  await page.getByTestId('cancel-slot').click();

  // 回到首页：提示里点名晚餐已经跟着退回了（否则家人只会看到晚餐莫名其妙变回未定）
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  await expect(page.getByTestId('release-notice')).toContainText(dinner);

  // 库里两边都是未定
  expect((await getSlot(page, lunch)).slot.status).toBe('undecided');
  expect((await getSlot(page, dinner)).slot.status).toBe('undecided');
});

test('S4：午餐没标留量时晚餐没有「吃剩的」入口（没有可吃剩的）', async ({ page }) => {
  await clearDecidedSlots(page);
  const { lunch, dinner } = await findLunchDinnerPair(page);

  const { status } = await put(page, lunch, {
    diners: ['mom', 'dad'],
    dishes: [{ recipeId: 'fanqiechaodan' }],
  });
  expect(status).toBe(200);

  expect((await getSlot(page, dinner)).slot.leftoverSource).toBeNull();
  await page.goto(`${ROOT_URL}/slot/${dinner}`);
  await expect(page.getByTestId('leftover-entry')).toBeHidden();
});
