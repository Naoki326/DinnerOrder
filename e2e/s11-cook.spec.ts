import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 掌勺者按**餐槽**指定（本票需求变更：从家人身上的全局标记 → 跟着每一餐走）＋ 页头日期
 * 走服务端下发（本票修的两个「今天页」bug 之一）。
 *
 * ## 为什么文件名是 `s11-`（排在 `meal.spec.ts` 之后）
 *
 * `meal.spec.ts` 的第一条用例断言「未定餐槽的留痕为空」（`history-empty`），而本 spec 会为
 * **它拿到的那张餐槽**写下菜单与留痕（append-only 清不掉）。Playwright 按字典序跑文件，
 * `s11-...` > `meal.spec.ts`，所以本 spec 在它之后跑，不会污染那条断言。
 *
 * ## 断言只做「相对本次操作」
 *
 * 留痕 append-only、多个 spec 共用一个 webServer 文件库：多轮 E2E 会累积历史，所以这里不写死
 * 事件条数，只断言「这一次操作之后读回来的值」。
 *
 * 时间基准是真实时钟（E2E webServer 不注入假时钟），餐槽日期一律从 `/api/slots` 现取。
 */
interface SlotJson {
  id: string;
  date: string;
  meal: 'lunch' | 'dinner';
  status: 'undecided' | 'decided';
  cook: { memberId: string; name: string; emoji: string } | null;
  cookDefault: { memberId: string; name: string; emoji: string } | null;
  menu: { diners: { memberId: string }[]; dishes: { recipeId: string }[] } | null;
}

async function listSlots(page: Page, days = 14): Promise<{ today: string; slots: SlotJson[] }> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as { today: string; slots: SlotJson[] };
}

async function getSlot(page: Page, id: string): Promise<SlotJson> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { slot: SlotJson }).slot;
}

/** 清场：窗口内已定的餐槽全取消（与 meal.spec 同口径：让首屏回到干净的空卡） */
async function clearDecidedSlots(page: Page): Promise<void> {
  const { slots } = await listSlots(page);
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    if (!cancelled.ok()) {
      // 取消被「吃剩的」引用的那一餐会联动退回引用方（#22），清场时可能撞上——那时是 404 not_decided
      const body = (await cancelled.json()) as { error?: string };
      expect(body.error).toBe('not_decided');
    }
  }
}

/** 清场反馈：点踩会触发冷藏期，而冷藏期跨用例留在同一个文件库里（与 review.spec 同口径） */
async function clearFeedback(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/feedback?days=90`);
  expect(response.ok()).toBe(true);
  const { feedback } = (await response.json()) as {
    feedback: { slotId: string; recipeId: string; memberId: string }[];
  };
  for (const item of feedback) {
    await page.request.delete(`${ROOT_URL}/api/feedback`, { data: item });
  }
}

/**
 * 取一张干净的餐槽用于本用例。
 *
 * 注：`index 0` 就是首页大卡那张（`meal.spec.ts` 断言「未定餐槽留痕为空」的那张）。本 spec
 * 直接写它是有意的：文件名 `s11-...` 排在 `meal.spec.ts` **之后**（Playwright 按字典序跑），
 * 所以本 spec 执行时 `meal.spec` 已经跑完——写留痕不会污染它的断言。反面教训见
 * `s4-leftover.spec.ts` 的 `findLunchDinnerPair`（它为了保险跳过了第一张午餐）。
 * 留痕 append-only、多轮 E2E 累积，所以断言只做「相对本次操作」。
 */
async function targetSlot(page: Page, index = 0): Promise<{ slot: SlotJson; today: string }> {
  const { today, slots } = await listSlots(page);
  const undecided = slots.filter((item) => item.status === 'undecided');
  const slot = undecided[index] ?? undecided[0];
  expect(slot, '窗口内至少要有一张未定的餐槽').toBeTruthy();
  return { slot: slot!, today };
}

test.afterEach(async ({ page }) => {
  await clearFeedback(page);
  await clearDecidedSlots(page);
});

test('餐槽卡上选掌勺者 → 卡片与编辑器都看得见 → 改掉之后读回是新的（按餐指定）', async ({ page }) => {
  await clearDecidedSlots(page);
  const { slot } = await targetSlot(page);

  // 进编辑器：掌勺者选择器在。缺省那位是按“上一餐继承”推导的（不写死是谁）——
  // 用服务端下发的 `cookDefault` 现取，证明编辑器预选的就是服务端缺省口径。
  const defaultCook = (await getSlot(page, slot.id)).cookDefault;
  expect(defaultCook, '未定餐槽应下发一个缺省掌勺者').toBeTruthy();
  await page.goto(`${ROOT_URL}/slot/${slot.id}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();
  await expect(page.getByTestId('cook-picker')).toBeVisible();
  await expect(page.getByTestId(`cook-${defaultCook!.memberId}`)).toHaveAttribute('aria-pressed', 'true');

  // 换成爸爸：本餐的掌勺者就该是他（与全局 is_cook 无关——这正是「按餐指定」）
  await page.getByTestId('cook-dad').click();
  await expect(page.getByTestId('cook-dad')).toHaveAttribute('aria-pressed', 'true');

  // 挑一道菜，保存
  await page.getByTestId('pick-fanqiechaodan').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  // 服务端读回来：这一餐的掌勺者是爸爸（快照带姓名/头像）
  const booked = await getSlot(page, slot.id);
  expect(booked.status).toBe('decided');
  expect(booked.cook).toMatchObject({ memberId: 'dad', name: '爸爸', emoji: '👨' });

  // 首页卡片上看得见掌勺者（爸爸）。
  // ⚠️ 定完之后这张卡可能不再是「最近未定餐槽」大卡（大卡会让位给下一张未定的），而变成
  // 一张已定的小卡——两种卡都渲染掌勺者（大卡“掌勺者：👨 爸爸” / 小卡“👨🍳 爸爸”），
  // 所以按 `data-slot-id` 定位卡片、断言里面出现他的名字（两种卡的公共部分）。
  const card = page.locator(`[data-slot-id="${slot.id}"]`).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('爸爸');

  // 再改一餐的掌勺者（同一餐）：编辑器换回妈妈 → 读回是新的
  await page.goto(`${ROOT_URL}/slot/${slot.id}`);
  await expect(page.getByTestId('cook-picker')).toBeVisible();
  await expect(page.getByTestId('cook-dad')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('cook-mom').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  expect((await getSlot(page, slot.id)).cook?.memberId).toBe('mom');
});

test('不指定掌勺者时按上一餐继承：前一餐选了爸爸，后一餐编辑器默认就是爸爸', async ({ page }) => {
  await clearDecidedSlots(page);
  const { slots } = await listSlots(page, 14);
  // 取相邻两餐（午餐 → 晚餐或晚餐 → 次日午餐都行）：把先一餐定给爸爸，后一餐编辑器应默认爸爸
  const earlier = slots[0]!;
  const later = slots.find((item) => item.id !== earlier.id)!;
  expect(later, '窗口内至少要有两张餐槽').toBeTruthy();

  // 先一餐：编辑器选爸爸 → 保存
  await page.goto(`${ROOT_URL}/slot/${earlier.id}`);
  await page.getByTestId('cook-dad').click();
  await page.getByTestId('pick-fanqiechaodan').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  expect((await getSlot(page, earlier.id)).cook?.memberId).toBe('dad');

  // 后一餐：不碰掌勺者，编辑器应该把缺省预选成爸爸（**按上一餐继承**，而不是全局 is_cook 的妈妈）
  await page.goto(`${ROOT_URL}/slot/${later.id}`);
  await expect(page.getByTestId('cook-dad')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cook-mom')).toHaveAttribute('aria-pressed', 'false');
});

test('这一餐不指定掌勺者：卡片上说得清，服务端存 null', async ({ page }) => {
  await clearDecidedSlots(page);
  const { slot } = await targetSlot(page);
  // 缺省是按上一餐继承出来的（哪个 spec 在前面定过餐会影响它）——所以**不写死是谁**，
  // 从服务端下发的 `cookDefault` 现取，再用它定位那个 chip。
  const defaultCook = (await getSlot(page, slot.id)).cookDefault;
  expect(defaultCook, '未定餐槽应下发一个缺省掌勺者').toBeTruthy();
  const defaultId = defaultCook!.memberId;

  await page.goto(`${ROOT_URL}/slot/${slot.id}`);
  // 默认选中缺省那位；再点一下它 = 取消指定
  await expect(page.getByTestId(`cook-${defaultId}`)).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId(`cook-${defaultId}`).click();
  await expect(page.getByTestId(`cook-${defaultId}`)).toHaveAttribute('aria-pressed', 'false');

  await page.getByTestId('pick-fanqiechaodan').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  expect((await getSlot(page, slot.id)).cook).toBeNull();
  await expect(page.locator(`[data-slot-id="${slot.id}"]`).first()).toContainText('未指定');
});
/**
 * 页头日期走**服务端下发的家庭时区今天**（本票修的 bug：原先用 `new Date()` 浏览器本地时间）。
 *
 * 判别性：页头显示的日期必须与 `/api/slots` 的 `today` 对得上（同一个「今天」基准）——
 * 用浏览器本地时间算的实现，只有在 runner 恰好是家庭时区时才碰巧一致；这里断言的是
 * 「页头读的就是服务端那个值」，而不是「今天是几号」。
 */
test('页头日期与餐槽卡用同一个服务端「今天」（不是浏览器本地时间）', async ({ page }) => {
  await clearDecidedSlots(page);
  const { today } = await listSlots(page, 3);

  await page.goto(`${ROOT_URL}/`);
  const header = page.getByTestId('header-today');
  await expect(header).toBeVisible();

  // 与 dayLabel 同一口径：把服务端下发的 today 现算成「M 月 D 日 · 周X」
  const weekdays = '日一二三四五六';
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const weekday = weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  await expect(header).toHaveText(`${month} 月 ${day} 日 · 周${weekday}`);
});

/**
 * 冷藏期文案（本票修的 bug）：`until` 是**解禁日**（最后一次点踩 + 冷藏期天数），
 * 所以今天页说的是「`until` 起**可以再推**」。原先只说「`until` 起」，配合上文“暂时不推”
 * 会被读成“从这天开始不推”——语义反了。回顾页那句是对的，两处现在一致。
 */
test('今天页冷藏期文案说的是「until 起可以再推」（解禁日，不是起始日）', async ({ page }) => {
  await clearFeedback(page);
  await clearDecidedSlots(page);
  const { slots } = await listSlots(page, 14);
  const target = slots[0]!;

  // 像 review.spec 那样把整个窗口定满：这样没有未定餐槽，大卡就是第一张已定餐（`hero-cooling`
  // 只渲染在大卡上）。点踩最后一道 → 它进冷藏期。
  for (const slot of slots) {
    const booked = await page.request.put(`${ROOT_URL}/api/slots/${slot.id}`, {
      data: {
        diners: ['mom', 'dad'],
        dishes: [{ recipeId: 'suanrongcaixin' }, { recipeId: 'dongguapaigutang' }],
      },
    });
    expect(booked.ok()).toBe(true);
  }
  const dislike = await page.request.post(`${ROOT_URL}/api/feedback`, {
    data: { slotId: target.id, recipeId: 'dongguapaigutang', memberId: 'mom', verdict: 'dislike' },
  });
  expect(dislike.ok()).toBe(true);

  await page.goto(`${ROOT_URL}/`);
  const cooling = page.getByTestId('hero-cooling');
  await expect(cooling).toBeVisible();
  await expect(cooling).toContainText('冬瓜排骨汤');
  await expect(cooling).toContainText('起可以再推');

  // 回顾页那句本来就是对的（两处一致）；两处都不能只说「`until` 起」而不说“可以再推”
  await page.goto(`${ROOT_URL}/review`);
  await expect(page.getByTestId('cooling-list')).toContainText('起可以再推');
});
