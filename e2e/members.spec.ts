import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 家人管理：**新增与删除**（本票）。
 *
 * 覆盖链路：家人页顶部新增（一级表单）→ 出现在列表 → 定餐时能被选为用餐者 →
 * 删除（两步确认）→ 从列表消失 → 定餐时选不到；以及**删掉的正是当前身份**时
 * 兜底回退到掌勺者（`identity.tsx` 既有逻辑，本票不改它，但要有端到端证据）。
 *
 * 两条纪律（与 meal/review 同一套）：
 *   * **文件名排在 `meal.spec.ts` 之后**（`meal` < `members`）：本 spec 会往餐槽里写留痕
 *     （定一餐验证「能被选」），而 meal.spec 断言「未定餐槽的留痕为空」——留痕 append-only，清不掉。
 *   * **只用自己造的家人**：种子的 mom/dad/dabao/xiaobao 被 family.spec / views.spec 断言着
 *     （views 的三视图一致性对照还会用「不传名单 = 全员」比对推荐结果），
 *     多一个家人就会把那边的对照打红。所以每个用例收尾都把自己造的家人删干净。
 *
 * 删除是**软删除**（服务端 010 迁移）：历史（含反馈）保留，但家人页与用餐者名单里不再有他。
 */
interface MemberJson {
  id: string;
  name: string;
  emoji: string;
  kind: 'adult' | 'child';
  gender: 'male' | 'female';
  birthMonth: string | null;
  isCook: boolean;
}

/** 种子家人的 id：收尾清理时只删「不是这几个」的（本 spec 自己造的） */
const SEED_IDS = new Set(['mom', 'dad', 'dabao', 'xiaobao']);

async function listMembers(page: Page): Promise<MemberJson[]> {
  const response = await page.request.get(`${ROOT_URL}/api/members`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { members: MemberJson[] }).members;
}

/** 收尾：删掉本轮造出来的家人（按 id 排除种子）——见文件头的第二条纪律 */
async function clearAddedMembers(page: Page): Promise<void> {
  for (const member of await listMembers(page)) {
    if (SEED_IDS.has(member.id)) continue;
    const response = await page.request.delete(`${ROOT_URL}/api/members/${member.id}`);
    expect(response.status()).toBe(200);
  }
}

/** 窗口内已定的餐槽全取消（与 meal.spec 同一形状；本 spec 定的那一餐也要退回去） */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  const { slots } = (await response.json()) as { slots: { id: string; status: string }[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    expect(cancelled.ok()).toBe(true);
  }
}

async function nextUndecidedSlot(page: Page): Promise<string> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await response.json()) as { slots: { id: string; status: string }[] };
  const slot = slots.find((item) => item.status === 'undecided');
  if (!slot) throw new Error('窗口内没有未定的餐槽，清场逻辑出问题了');
  return slot.id;
}

/** 走一遍家人页上的新增表单（表单是唯一入口，不加后门） */
async function addMember(page: Page, fields: { name: string; emoji: string; kind: 'adult' | 'child' }): Promise<void> {
  await page.getByTestId('add-member').click();
  await expect(page.getByTestId('new-member-form')).toBeVisible();
  await page.getByTestId('new-member-name').fill(fields.name);
  await page.getByTestId(`new-member-emoji-${fields.emoji}`).click();
  await page.getByTestId(`new-member-kind-${fields.kind}`).click();
  await page.getByTestId(fields.kind === 'child' ? 'new-member-gender-male' : 'new-member-gender-female').click();
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
  await clearAddedMembers(page);
});

test('家人页新增一位家人：出现在列表、能进用餐者名单，删除后从列表与名单里消失', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/family`);
  await expect(page.getByTestId('family-view')).toBeVisible();

  // --- 新增：一级表单（不是分步向导），必填项齐了才提交 ---
  await addMember(page, { name: '姥姥', emoji: '👵', kind: 'adult' });
  await page.getByTestId('new-member-submit').click();
  await expect(page.getByTestId('new-member-form')).toBeHidden();

  // 落库了，且排在种子家人后面（sort_order = MAX + 1）
  const added = (await listMembers(page)).find((member) => member.name === '姥姥');
  expect(added, '新增的家人没落库').toBeTruthy();
  expect(added!.id).toMatch(/^m_/);
  expect((await listMembers(page)).map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝', '姥姥']);

  // 卡片上看得见（列表按 sort_order：新家人在最后一张卡）
  await expect(page.getByTestId(`member-${added!.id}`)).toContainText('姥姥');
  await expect(page.getByTestId(`member-subtitle-${added!.id}`)).toHaveText('大人 · 女');

  // --- 立即可用之一：能切为当前身份（身份切换器里也有他） ---
  await page.getByTestId('identity-chip').click();
  await expect(page.getByTestId(`identity-option-${added!.id}`)).toBeVisible();
  // 切回掌勺者（顺手关掉面板）——这一条验的是「他在切换器里」，不是「现在就用他的身份」
  await page.getByTestId('identity-option-mom').click();
  await expect(page.getByTestId('identity-name')).toHaveText('妈妈');

  // --- 立即可用之二：定餐时能被选为用餐者 ---
  const slotId = await nextUndecidedSlot(page);
  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId('diner-picker')).toBeVisible();
  // 默认全员（总纲 §3）：先把这个新家人之外的人都去掉，只留他——这才证明「能选他」，而不是「默认带着他」
  for (const seed of ['mom', 'dad', 'dabao', 'xiaobao']) {
    await expect(page.getByTestId(`diner-${seed}`)).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId(`diner-${seed}`).click();
    await expect(page.getByTestId(`diner-${seed}`)).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(page.getByTestId(`diner-${added!.id}`)).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('pick-fanqiechaodan').click();
  // 份量随名单即时重算（服务端算的那一份里也只有他）
  await expect(page.getByTestId('portion-summary')).toContainText('1 人合计');
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  const booked = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot } = (await booked.json()) as { slot: { menu: { diners: { memberId: string }[] } | null } };
  expect(slot.menu?.diners.map((diner) => diner.memberId)).toEqual([added!.id]);

  // --- 删除：两点式确认（一点就删是不允许的） ---
  await page.goto(`${ROOT_URL}/family`);
  const card = page.getByTestId(`member-${added!.id}`);
  await expect(card).toBeVisible();
  await page.getByTestId(`member-delete-${added!.id}`).click();
  await expect(page.getByTestId(`member-delete-confirm-${added!.id}`)).toBeVisible();
  // 确认条上说清是软删除（历史保留）——家人会问「那以前吃的还算吗」
  await expect(page.getByTestId(`member-delete-confirm-${added!.id}`)).toContainText('历史与反馈都保留');

  // 「不删了」→ 卡片原地留着（确认不是摆设）
  await page.getByTestId(`member-delete-cancel-${added!.id}`).click();
  await expect(card).toBeVisible();
  expect((await listMembers(page)).map((member) => member.name)).toContain('姥姥');

  // 再来一次，这回确认
  await page.getByTestId(`member-delete-${added!.id}`).click();
  await page.getByTestId(`member-delete-confirmed-${added!.id}`).click();
  await expect(card).toBeHidden();
  expect((await listMembers(page)).map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝']);

  // --- 从定餐名单里也消失了（同一条 `['members']` 查询，界面即刻反映）---
  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId(`diner-${added!.id}`)).toBeHidden();
  await expect(page.getByTestId('diner-mom')).toBeVisible();
  // 服务端那道门也关着：已删的家人不能再作为用餐者写进新菜单
  const rejected = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: { diners: [added!.id], dishes: [{ recipeId: 'fanqiechaodan' }] },
  });
  expect(rejected.status()).toBe(400);
  expect(((await rejected.json()) as { error: string; memberId: string }).memberId).toBe(added!.id);

  // 而这一餐**已经记下的**名单照旧读得出来（快照 + 软删除保住的画像：不是「查不到的人」）
  const after = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot: reread } = (await after.json()) as {
    slot: { menu: { diners: { memberId: string; name: string }[] } | null };
  };
  expect(reread.menu?.diners).toEqual([{ memberId: added!.id, name: '姥姥', emoji: '👵' }]);

  // 手机宽度：新增入口与该页在 390×844 下都不横向溢出
  await page.goto(`${ROOT_URL}/family`);
  await page.getByTestId('add-member').click();
  await expect(page.getByTestId('new-member-form')).toBeVisible();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});

test('小孩的新增表单：不给出生年月就提交不了，给了才存得下来', async ({ page }) => {
  await page.goto(`${ROOT_URL}/family`);

  await addMember(page, { name: '二宝', emoji: '👶', kind: 'child' });
  // 小孩必须有出生年月：表单层先拦（本地校验），给一句人话而不是笼统失败
  await page.getByTestId('new-member-submit').click();
  await expect(page.getByTestId('new-member-error')).toContainText('出生年月');
  expect((await listMembers(page)).map((member) => member.name)).not.toContain('二宝');

  await page.getByTestId('new-member-birth').fill('2021-09');
  await page.getByTestId('new-member-submit').click();
  await expect(page.getByTestId('new-member-form')).toBeHidden();
  const child = (await listMembers(page)).find((member) => member.name === '二宝');
  expect(child).toMatchObject({ kind: 'child', gender: 'male', birthMonth: '2021-09' });
  await expect(page.getByTestId(`member-subtitle-${child!.id}`)).toContainText('岁');

  // 名字空也提交不了（服务端 + 表单各一道；这里验表单那一道）
  await page.getByTestId('add-member').click();
  await page.getByTestId('new-member-emoji-👴').click();
  await page.getByTestId('new-member-kind-adult').click();
  await page.getByTestId('new-member-gender-male').click();
  await page.getByTestId('new-member-submit').click();
  await expect(page.getByTestId('new-member-error')).toContainText('名字不能为空');
});

test('删掉的正是当前身份：本设备身份自动回退到掌勺者（identity.tsx 的既有兜底）', async ({ page }) => {
  await page.goto(`${ROOT_URL}/family`);
  await addMember(page, { name: '姥姥', emoji: '👵', kind: 'adult' });
  await page.getByTestId('new-member-submit').click();
  await expect(page.getByTestId('new-member-form')).toBeHidden();
  const added = (await listMembers(page)).find((member) => member.name === '姥姥');
  expect(added).toBeTruthy();

  // 把这台设备的当前身份切成他
  await page.getByTestId('identity-chip').click();
  await page.getByTestId(`identity-option-${added!.id}`).click();
  await expect(page.getByTestId('identity-name')).toHaveText('姥姥');

  // 然后把他删掉：卡上的「当前身份」标记随卡片一起没了，顶部身份条回退到掌勺者（妈妈）
  await page.getByTestId(`member-delete-${added!.id}`).click();
  await page.getByTestId(`member-delete-confirmed-${added!.id}`).click();
  await expect(page.getByTestId(`member-${added!.id}`)).toBeHidden();
  await expect(page.getByTestId('identity-name')).toHaveText('妈妈');

  // 刷新也还是掌勺者：回退写回了本设备存储，不是只在内存里的一次性兜底
  await page.reload();
  await expect(page.getByTestId('identity-name')).toHaveText('妈妈');
});

/**
 * 把一组用餐者的勾选状态设成 `on`（已经是对的就跳过）。每一次点击都当场断言——
 * 否则一个没生效的点击会以“名单不对”的形式在几步之后才暴露，根因不好找。
 */
async function setDiners(page: Page, ids: string[], on: boolean): Promise<void> {
  for (const id of ids) {
    const chip = page.getByTestId(`diner-${id}`);
    if ((await chip.getAttribute('aria-pressed')) === String(on)) continue;
    await chip.click();
    await expect(chip, `diner-${id} 应被${on ? '选中' : '取消'}`).toHaveAttribute('aria-pressed', String(on));
  }
}

/**
 * 定一餐（只带一位指定家人）、再把那个人删掉，回到那一餐的编辑器。
 * 返回餐槽 id 与被删家人的 id。
 */
async function bookThenDeleteDiner(page: Page, who: { name: string; emoji: string }): Promise<{ slotId: string; goneId: string }> {
  await page.goto(`${ROOT_URL}/family`);
  await addMember(page, { name: who.name, emoji: who.emoji, kind: 'adult' });
  await page.getByTestId('new-member-submit').click();
  await expect(page.getByTestId('new-member-form')).toBeHidden();
  const added = (await listMembers(page)).find((member) => member.name === who.name);
  expect(added, '新增的家人没落库').toBeTruthy();

  const slotId = await nextUndecidedSlot(page);
  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId('diner-picker')).toBeVisible();
  // 只留这一位家人（其余种子家人点掉），保存成一份“只有他”的菜单
  await setDiners(page, ['mom', 'dad', 'dabao', 'xiaobao'], false);
  await expect(page.getByTestId(`diner-${added!.id}`)).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('pick-fanqiechaodan').click();
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);

  // 把他删掉：菜单快照里还留着他的 id（软删除不改写历史）
  await page.goto(`${ROOT_URL}/family`);
  await page.getByTestId(`member-delete-${added!.id}`).click();
  await page.getByTestId(`member-delete-confirmed-${added!.id}`).click();
  await expect(page.getByTestId(`member-${added!.id}`)).toBeHidden();
  return { slotId, goneId: added!.id };
}

/**
 * 已定菜单里含**已删家人**时，编辑器必须有路可走（本票修复的洞）。
 *
 * 修复前：草稿名单取自菜单快照（含已删的人）→ 份量预览 400 `unknown_member`（份量区空白）；
 * 想要保存也是同一个 400；而用餐者选择器只渲染在册家人，**界面上没有那个人的 chip 可点**
 * ——用户唯一的出路是放弃这一餐，连“改别的菜”都做不到（份量算不出来）。
 *
 * 现在：已删的家人在名单里以一张标了「已删」的 chip 出现（排除可见），点一下就回到正轨；
 * 在那之前份量按剩下的人算（不是空白），保存会在本地被拦下并说清下一步。
 */
test('已定菜单含已删家人：编辑器里看得到份量、点掉「已删」就能存回去', async ({ page }) => {
  const { slotId, goneId } = await bookThenDeleteDiner(page, { name: '姥姥', emoji: '👵' });

  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();

  // 已删的家人在地选名单里出现，标着「已删」（不是静默消失，也不是不可点）
  const ghost = page.getByTestId(`diner-ghost-${goneId}`);
  await expect(ghost).toBeVisible();
  await expect(ghost).toContainText('姥姥');
  await expect(ghost).toContainText('已删');
  await expect(ghost).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('diner-ghost-note')).toContainText('姥姥');

  // 份量算得出来（按剩下的家人算）。名单里只剩这位已删的家人时份量是空的，所以先补一位在册的
  // ——这恰好也是真实用户的第一步（想接着吃这一餐，得先把“现在到底谁吃”点清楚）。
  await setDiners(page, ['mom'], true);
  await expect(page.getByTestId('portion-summary')).toBeVisible();
  await expect(page.getByTestId('portion-summary')).toContainText('人合计');

  // 份量读数旁的**口径注记**（本票修复 ①）：ghost chip 还是按下状态（看起来在名单里），
  // 而人数与克数已经把他剔掉了——不点那个 chip 的人也必须看得出这份读数不含已删家人
  await expect(ghost).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('portion-summary')).toContainText('1 人合计');
  const portionNote = page.getByTestId('portion-ghost-note');
  await expect(portionNote).toBeVisible();
  await expect(portionNote).toContainText('姥姥');
  await expect(portionNote).toContainText('没算进份量');
  // 手机宽度：口径注记要换行而不是把卡片撑宽
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // 带着 ghost 保存：在本地被拦下并说清下一步（不去打注定 400 的请求）
  await page.getByTestId('save-slot').click();
  await expect(page.getByTestId('slot-error-message')).toContainText('已不在家人列表里');
  expect(page.url()).toContain(`/slot/${slotId}`);

  // 点掉那个 chip：名单里不再有已删的人，口径注记随之退场（数字不再需要解释）
  await ghost.click();
  await expect(ghost).toHaveAttribute('aria-pressed', 'false');
  await expect(portionNote).toBeHidden();

  // 现在存得回去，菜单里不再有他；留痕里也看得到这次改动
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  const after = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot, history } = (await after.json()) as {
    slot: { menu: { diners: { memberId: string }[] } | null };
    history: { type: string; diners: { memberId: string }[] }[];
  };
  expect(slot.menu?.diners.map((diner) => diner.memberId)).toEqual(['mom']);
  expect(history.at(-1)?.diners.map((diner) => diner.memberId)).toEqual(['mom']);
  // 历史没被改写：上一版菜单里他还在（append-only，删家人不改写留痕）。
  // 不断言 `history[0]`：留痕是 append-only 且 E2E 共用一个库，这个餐槽的头部事件
  // 是之前几轮跑出来的，不属于本次操作（库里的老规矩：只做相对断言）。
  const previous = history.at(-2);
  expect(previous, '这一餐应该至少有过两条事件').toBeTruthy();
  expect(previous?.diners.map((diner) => diner.memberId)).toContain(goneId);

  // 回到那一餐也不再看到 ghost（新的菜单快照里没有他了）
  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId(`diner-ghost-${goneId}`)).toBeHidden();

  // 手机宽度：编辑器在 390×844 下不横向溢出（ghost chip 比普通 chip 宽一截）
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});

/**
 * 「全部移除」那一拍：名单里可能有好几位已删的家人，逐个点两下太磨人。
 * 按钮与逐个点等价（同一个 `setDinersDraft`），但人多的时候是唯一好用的出路。
 */
test('已定菜单含已删家人：「移除已删的家人」一拍清掉，份量与保存同时恢复', async ({ page }) => {
  const { slotId, goneId } = await bookThenDeleteDiner(page, { name: '姥爷', emoji: '👴' });
  await page.goto(`${ROOT_URL}/slot/${slotId}`);

  await expect(page.getByTestId(`diner-ghost-${goneId}`)).toBeVisible();
  // 名单里只剩已删的家人时，一键移除会把名单清空——服务端要的是“至少一位用餐者”，
  // 所以先补一位在册的（下一条断言同时证明份量随名单重算）
  await setDiners(page, ['mom'], true);
  await page.getByTestId('diner-ghost-remove-all').click();
  await expect(page.getByTestId(`diner-ghost-${goneId}`)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('diner-ghost-note')).toContainText('已经从这一餐的草稿里移除');

  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(`${ROOT_URL}/`);
  const after = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot } = (await after.json()) as { slot: { menu: { diners: { memberId: string }[] } | null } };
  expect(slot.menu?.diners.map((diner) => diner.memberId)).toEqual(['mom']);
});

/**
 * 家人名单读不回来时，份量区要说清为什么算不出来（本票修复 ②）。
 *
 * 背景：名单没到位前不发份量请求（`usePortionPreview` 的 `ready`，见 `SlotView.tsx` 的 `rosterKnown`）
 * ——这是对的（否则快照里的已删家人会被当成未知成员，白吃一次注定 400 的请求）。
 * 但名单查询**失败**时（`retry: 1` 之后仍是 error），`isSuccess` 永远不为真 → 份量请求永不发，
 * 而 `portionQuery.isError` 也为假 → 份量区一片静默空白。用户看不出发生了什么。
 *
 * 这条把 `GET /api/members` 在浏览器侧按断（`page.route` + abort，照 `views.spec.ts` 那道
 * 把请求按在网里的先例），断言份量区**显示出说明**而不是空白；判别性在：不显示说明的实现
 * 会让 `portion-error` 永远不可见（`portion-summary` 也不会出现，两边都空）。
 */
test('家人名单读不回来：份量区说清原因，而不是静默空白', async ({ page }) => {
  // 先造一桌**已定且带菜**的餐：平时这一屏会算出份量，所以「空白」是真问题而不是「没菜可算」
  const slotId = await nextUndecidedSlot(page);
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: { diners: ['mom', 'dad'], dishes: [{ recipeId: 'fanqiechaodan' }] },
  });
  expect(booked.ok(), `定餐失败：HTTP ${booked.status()}`).toBe(true);

  // 浏览器侧打断家人名单（`page.request` 是另一条上下文，不受这条 route 影响，收尾照常）
  const membersRequest = (url: URL): boolean => url.pathname === '/api/members';
  await page.route(membersRequest, (route) => route.abort('failed'));

  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();

  // 份量区给出人话说明：是「名单没读回来」，不是空白、也不是「没人吃」
  const portionError = page.getByTestId('portion-error');
  await expect(portionError).toBeVisible();
  await expect(portionError).toContainText('家人列表没读回来');
  await expect(portionError).toContainText('份量');
  // 而且没有拿一份算不出来的读数糊弄（没有 summary 卡）
  await expect(page.getByTestId('portion-summary')).toBeHidden();

  await page.unroute(membersRequest);
});
