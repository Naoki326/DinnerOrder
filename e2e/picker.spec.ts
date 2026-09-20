import { expect, test, type Page } from '@playwright/test';
import { E2E, ROOT_URL } from './test-env';

/**
 * 加菜器的搜索与筛选（#27）：276 道菜（含 257 道外部草稿）里 10 秒挑出一道。
 *
 * 覆盖的是**用户可见的行为**：输字出菜、筛完还剩哪些按钮、空态、清空、已选不被筛掉、
 * 退役菜照旧不出现、手机上不吃穿。服务端一行没改（纯前端过滤），所以这里不碰任何 API 断言
 * ——唯一用接口的地方是「找一张未定餐槽进编辑器」与开工前清场。
 *
 * 三条仓库纪律：
 *   * 文件名 `picker.spec.ts` 排在 `meal.spec.ts` **之后**（`m` < `p`）：本 spec 若排在它之前、
 *     又往餐槽写留痕，会打红那条「未定餐槽留痕为空」的断言。本 spec 的用例**只在编辑器里点菜、
 *     不保存**——筛选与已选草稿都是页面本地状态，一个字都不落库；只有开工前的清场（取消已定餐槽）
 *     会写 cancel 留痕，那是各 spec 共用同一张文件库的必然代价（所以文件名顺序仍然是必需的）。
 *   * 不写死道数：库里有多少道菜随种子变，断言一律「界面上的读数 == 界面上按钮的个数」这种
 *     相对写法（留痕 append-only 那套教训的同一道理）。
 *   * 时间基准是真实时钟（webServer 不注入假时钟），餐槽 id 一律从 `/api/slots` 现取。
 *
 * 「没做过」的口径是**草稿**（与按钮上的小标、`CandidateList`、CONTEXT.md 的「草稿 = 外部」同一
 * 口径）——所以「筛没做过」的结果里，每一条都必须带那枚小标；下面把它当不变量断言。
 */
interface SlotJson {
  id: string;
  status: 'undecided' | 'decided';
}

/** 清场：窗口内已定的餐槽全取消（与其余 spec 同口径，保证「最近未定餐槽」是一张干净的空卡） */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  expect(response.ok()).toBe(true);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    expect(cancelled.ok()).toBe(true);
  }
}

async function nextUndecidedSlot(page: Page): Promise<string> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  const slot = slots.find((item) => item.status === 'undecided');
  if (!slot) throw new Error('窗口内没有未定的餐槽，清场逻辑出问题了');
  return slot.id;
}

/** 打开定餐编辑器（加菜器的唯一落点：A 视图的槽位页），并把加菜器展开（默认收起） */
async function openEditor(page: Page): Promise<string> {
  const slotId = await nextUndecidedSlot(page);
  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();
  await expect(page.getByTestId('dish-picker')).toBeVisible();
  await page.getByTestId('dish-picker-toggle').click();
  await expect(page.getByTestId('dish-picker-toggle')).toHaveAttribute('aria-expanded', 'true');
  return slotId;
}

/** 加菜器上现在看得见多少个加菜按钮（`pick-<id>` 是本仓的既有惯例） */
function pickButtons(page: Page) {
  return page.locator('[data-testid^="pick-"]');
}

/** 「筛出 N 道（共 M 道）」里的两个数字 */
async function filterCounts(page: Page): Promise<{ shown: number; total: number }> {
  const text = (await page.getByTestId('dish-filter-count').innerText()).trim();
  const match = /(?:筛出\s*(\d+)\s*道（共\s*(\d+)\s*道）|共\s*(\d+)\s*道)/.exec(text);
  if (!match) throw new Error(`读数不是预期的形状：${text}`);
  if (match[3] !== undefined) return { shown: Number(match[3]), total: Number(match[3]) };
  return { shown: Number(match[1]), total: Number(match[2]) };
}

/** 读数与按钮数对账：界面上说「筛出 N 道」，那就该有 N 个按钮 */
async function expectCountMatches(page: Page): Promise<void> {
  const counts = await filterCounts(page);
  await expect(pickButtons(page)).toHaveCount(counts.shown);
}

/** 份量小结里那行「…共 X g」的读数（筛选不该改动它：它按已选**全集**算） */
async function summaryGrams(page: Page): Promise<string> {
  const text = await page.getByTestId('portion-summary').innerText();
  const grams = /共\s*([\d.]+)\s*g/.exec(text)?.[1];
  if (!grams) throw new Error(`份量小结里没读到克数：${text}`);
  return grams;
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

test('按名字模糊搜索：输一个字直达，其余隐去；搜不到有空态，清空回全量', async ({ page }) => {
  await clearDecidedSlots(page);
  await openEditor(page);

  const before = await filterCounts(page);
  expect(before.shown).toBe(before.total);

  // 输「鸡」：含鸡的菜留下（不必记得全名），不含的隐去
  await page.getByTestId('dish-search-input').fill('鸡');
  await expect(page.getByTestId('pick-kelejichi')).toBeVisible();
  await expect(page.getByTestId('pick-huangmenji')).toBeVisible();
  await expect(page.getByTestId('pick-suanrongcaixin')).toBeHidden();
  await expectCountMatches(page);

  // 别名也算命中（宫保鸡丁的别名是宫爆鸡丁）——「不必记得全名」的另一半
  await page.getByTestId('dish-search-input').fill('宫爆');
  await expect(page.getByTestId('pick-gongbaojiding')).toBeVisible();
  await expectCountMatches(page);

  // 搜不到：给一句人话，不是一片空白
  await page.getByTestId('dish-search-input').fill('zzz没有这道菜');
  await expect(page.getByTestId('dish-filter-empty')).toBeVisible();
  await expect(pickButtons(page)).toHaveCount(0);

  // 清空筛选 → 回到全量
  await page.getByTestId('dish-filter-clear').click();
  await expect(page.getByTestId('dish-search-input')).toHaveValue('');
  await expect(page.getByTestId('dish-filter-empty')).toBeHidden();
  await expect(pickButtons(page)).toHaveCount(before.total);
  await expect(page.getByTestId('dish-filter-count')).toContainText(`共 ${before.total} 道`);
});

test('按主料搜：名字里没有的词也能搜到（家里有什么就搜什么），并标出是哪味食材命中', async ({ page }) => {
  await clearDecidedSlots(page);
  await openEditor(page);

  // 「猪排骨」不在任何菜谱的名字里（红烧排骨、冬瓜排骨汤、玉米胡萝卜排骨汤），只在食材清单里
  await page.getByTestId('dish-search-input').fill('猪排骨');
  await expect(page.getByTestId('pick-hongshaopaigu')).toBeVisible();
  await expect(page.getByTestId('pick-hongshaopaigu')).toContainText('含猪排骨');
  await expect(page.getByTestId('pick-dongguapaigutang')).toBeVisible();
  await expect(page.getByTestId('pick-suanrongcaixin')).toBeHidden();
  await expectCountMatches(page);

  // 「土豆」：黄焖鸡的名字里没有土豆，但主料里有（黄焖鸡 = 鸡腿 + 青椒 + 土豆）
  await page.getByTestId('dish-search-input').fill('土豆');
  await expect(page.getByTestId('pick-huangmenji')).toBeVisible();
  await expect(page.getByTestId('pick-huangmenji')).toContainText('含土豆');
  await expect(page.getByTestId('pick-tudouniuniu')).toBeVisible();
  // 名字命中主料的那道（土豆炖牛腩）不标「含」——那枚小注只解释「为什么它在」
  await expect(page.getByTestId('pick-tudouniuniu')).not.toContainText('含土豆');
  await expectCountMatches(page);
});

test('「做过 / 没做过」筛选：口径 = 草稿，与按钮上的小标同源', async ({ page }) => {
  await clearDecidedSlots(page);
  await openEditor(page);

  // 没做过 = 草稿（外部补位池的菜）：筛出来的每一条都带「没做过」小标，家庭菜一条不留
  await page.getByTestId('filter-status-untried').click();
  await expect(page.getByTestId('filter-status-untried')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pick-xiangguhuaji')).toContainText('没做过');
  await expect(page.getByTestId('pick-hongshaopaigu')).toBeHidden();
  await expectCountMatches(page);
  const untried = await pickButtons(page).allTextContents();
  expect(untried.length).toBeGreaterThan(0);
  expect(untried.every((text) => text.includes('没做过'))).toBe(true);

  // 做过 = 家庭菜（转正态）：熟悉的菜快速可选，草稿一条不留
  await page.getByTestId('filter-status-tried').click();
  await expect(page.getByTestId('pick-hongshaopaigu')).toBeVisible();
  await expect(page.getByTestId('pick-hongshaopaigu')).not.toContainText('没做过');
  await expect(page.getByTestId('pick-xiangguhuaji')).toBeHidden();
  await expectCountMatches(page);
  const tried = await pickButtons(page).allTextContents();
  expect(tried.every((text) => !text.includes('没做过'))).toBe(true);

  // 全部 = 两拨合起来，比任一边都多
  await page.getByTestId('filter-status-all').click();
  await expectCountMatches(page);
  const all = await filterCounts(page);
  expect(all.shown).toBeGreaterThan(untried.length);
  expect(all.shown).toBeGreaterThan(tried.length);
});

test('菜系与难度筛选可组合；筛完仍按荤/素/汤分组', async ({ page }) => {
  await clearDecidedSlots(page);
  await openEditor(page);

  // 菜系：川 → 麻婆豆腐（家庭菜）与宫保鸡丁/回锅肉/家常豆腐（草稿）都在，粤菜与家常菜隐去
  await page.getByTestId('filter-cuisine').selectOption('川');
  await expect(page.getByTestId('pick-mapodoufu')).toBeVisible();
  await expect(page.getByTestId('pick-gongbaojiding')).toBeVisible();
  await expect(page.getByTestId('pick-baizhuoxia')).toBeHidden();
  await expect(page.getByTestId('pick-hongshaopaigu')).toBeHidden();
  await expectCountMatches(page);

  // 「未标」（cuisine = null，导入期 LLM 初打没跑成的那些）也有自己的一档——否则它们一旦动了
  // 菜系筛选就永远不可达（筛选器不该有看不见的洞）。香菇滑鸡就是种子里的未标草稿。
  await page.getByTestId('filter-cuisine').selectOption('none');
  await expect(page.getByTestId('pick-xiangguhuaji')).toBeVisible();
  await expect(page.getByTestId('pick-mapodoufu')).toBeHidden();
  await expectCountMatches(page);
  await page.getByTestId('filter-cuisine').selectOption('川');

  // 组合：川 + 没做过 → 家庭菜那一道（麻婆豆腐）也被筛掉
  await page.getByTestId('filter-status-untried').click();
  await expect(page.getByTestId('pick-gongbaojiding')).toBeVisible();
  await expect(page.getByTestId('pick-mapodoufu')).toBeHidden();
  await expectCountMatches(page);

  // 换难度：川 + 没做过 + 快手 → 川味草稿里没有快手的（宫保鸡丁中等、回锅肉中等、家常豆腐中等）
  await page.getByTestId('filter-effort-quick').click();
  await expect(page.getByTestId('dish-filter-empty')).toBeVisible();

  // 松一格（难度回「全部」）：难度筛选本身也要真管事——快手 + 做过里没有慢菜
  await page.getByTestId('filter-effort-all').click();
  await page.getByTestId('filter-status-tried').click();
  await page.getByTestId('filter-cuisine').selectOption('all');
  await page.getByTestId('filter-effort-quick').click();
  await expect(page.getByTestId('pick-baizhuoxia')).toBeVisible();
  await expect(page.getByTestId('pick-hongshaopaigu')).toBeHidden();
  await expect(page.getByTestId('pick-tangculiji')).toBeHidden();
  await expectCountMatches(page);

  // 分组保持：荤 → 素 → 荤汤 → 素汤 的相对顺序不变（只是组内少了被筛掉的菜）
  await page.getByTestId('dish-filter-clear').click();
  await page.getByTestId('filter-status-untried').click();
  const groups = await page.locator('[data-testid^="dish-group-"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-testid')),
  );
  const order = ['dish-group-meat', 'dish-group-veg', 'dish-group-soup_meat', 'dish-group-soup_veg'];
  const positions = groups.map((id) => order.indexOf(id ?? '')).filter((index) => index >= 0);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(groups).toContain('dish-group-meat');
  expect(groups).toContain('dish-group-veg');
});

test('筛选只改可见性：已选的菜不丢、份量小结照旧按已选全集算', async ({ page }) => {
  await clearDecidedSlots(page);
  await openEditor(page);

  // 先挑两道家常菜（一荤一素）
  await page.getByTestId('pick-hongshaopaigu').click();
  await page.getByTestId('pick-fanqiechaodan').click();
  await expect(page.getByTestId('chosen-hongshaopaigu')).toBeVisible();
  await expect(page.getByTestId('portion-summary')).toBeVisible();
  // 份量小结里那行「共 X g」——筛选不该改动它（它按已选**全集**算）
  const gramsBefore = await summaryGrams(page);

  // 筛「没做过」：两道都被筛掉，但它们仍在「这一餐的菜」里，读数也不变
  await page.getByTestId('filter-status-untried').click();
  await expect(page.getByTestId('pick-hongshaopaigu')).toBeHidden();
  await expect(page.getByTestId('pick-fanqiechaodan')).toBeHidden();
  await expect(page.getByTestId('chosen-hongshaopaigu')).toBeVisible();
  await expect(page.getByTestId('chosen-fanqiechaodan')).toBeVisible();
  await expect(page.getByTestId('dish-filter-hidden-chosen')).toContainText('2 道已选的菜被筛掉了');
  expect(await summaryGrams(page)).toBe(gramsBefore);

  // 筛选期间还能继续挑（挑一道没做过的）：它同时进「已选」与被筛后的列表，
  // 并且带着「没做过」小标进菜单（story 20：上桌前的预期）
  await page.getByTestId('pick-xiangguhuaji').click();
  await expect(page.getByTestId('chosen-xiangguhuaji')).toBeVisible();
  await expect(page.getByTestId('chosen-untried-xiangguhuaji')).toContainText('没做过');
  // 家庭菜（做过的）不带这枚小标——同一页只有一个「没做过」的口径
  await expect(page.getByTestId('chosen-untried-hongshaopaigu')).toHaveCount(0);
  await expect(page.getByTestId('pick-xiangguhuaji')).toHaveAttribute('aria-pressed', 'true');
  // 被筛掉的那两道仍算在份量里（读数变了是因为多了一道菜，不是少了被隐藏的）
  expect(await summaryGrams(page)).not.toBe(gramsBefore);

  // 清空筛选：被筛掉的已选菜重新可见（能找回、能反悔）
  await page.getByTestId('dish-filter-clear').click();
  await expect(page.getByTestId('dish-filter-hidden-chosen')).toBeHidden();
  await expect(page.getByTestId('pick-hongshaopaigu')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pick-fanqiechaodan')).toHaveAttribute('aria-pressed', 'true');

  // 再点一下就退掉（加菜器仍是同一份状态的开关）
  await page.getByTestId('pick-hongshaopaigu').click();
  await expect(page.getByTestId('chosen-hongshaopaigu')).toBeHidden();
});

test('退役菜照旧不进加菜器；搜索与筛选是本次打开的临时状态（刷新即回全量）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await openEditor(page);

  // 退役（家里不再做）：搜也搜不出来，不是「藏在后面」
  await page.getByTestId('dish-search-input').fill('带鱼');
  await expect(page.getByTestId('dish-filter-empty')).toBeVisible();
  await expect(page.getByTestId('pick-xiangjiandaiyu')).toHaveCount(0);

  // 不持久化：换个页面回来、或原地刷新，都是干净的全量（不进路由、不进存储、不跨设备）
  // 刷新后加菜器也回到**默认收起**（展开与否同样是临时状态），所以先展开再看筛选
  await page.reload();
  await expect(page.getByTestId('dish-picker')).toBeVisible();
  await expect(page.getByTestId('dish-picker-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('dish-picker-toggle').click();
  await expect(page.getByTestId('dish-search-input')).toHaveValue('');
  await expect(page.getByTestId('filter-status-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('filter-effort-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('filter-cuisine')).toHaveValue('all');
  await expect(page.getByTestId('dish-filter-count')).toContainText(`共 ${(await filterCounts(page)).total} 道`);
  await expect(page.getByTestId('dish-filter-clear')).toBeDisabled();
  await expect(page).toHaveURL(`${ROOT_URL}/slot/${slotId}`);
});

test('加菜器默认收起：一行行头，点开才铺开；收起不丢已选与筛选', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await expect(page.getByTestId('slot-view')).toBeVisible();

  // 默认收起：只有行头，搜索/筛选/菜按钮全不在（这一屏的长短由「这一餐的菜」说了算）
  const toggle = page.getByTestId('dish-picker-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('展开');
  await expect(page.getByTestId('dish-search-input')).toBeHidden();
  await expect(page.getByTestId('filter-status-all')).toBeHidden();
  await expect(pickButtons(page)).toHaveCount(0);

  // 点一下展开：搜索 + 筛选 + 按钮都回来了
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toContainText('收起');
  await expect(page.getByTestId('dish-search-input')).toBeVisible();
  const total = (await filterCounts(page)).total;
  expect(total).toBeGreaterThan(0);

  // 收起不丢状态：先选一道、再搜一个词，收起后行头报出已选道数，展开回来原样还在
  await page.getByTestId('pick-hongshaopaigu').click();
  await page.getByTestId('dish-search-input').fill('土豆');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('已选 1 道');
  await expect(page.getByTestId('chosen-hongshaopaigu')).toBeVisible();

  // 展开回来：搜索词与筛选、以及「已选的那道被筛掉了」那句提示都还在（收起只藏不重置）
  await toggle.click();
  await expect(page.getByTestId('dish-search-input')).toHaveValue('土豆');
  await expect(page.getByTestId('dish-filter-hidden-chosen')).toContainText('1 道已选的菜被筛掉了');
  await page.getByTestId('dish-filter-clear').click();
  await expect(page.getByTestId('pick-hongshaopaigu')).toHaveAttribute('aria-pressed', 'true');

  // 收起态也不许把页面撑宽（行头是整行按钮 + 三块文字）
  await toggle.click();
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1);
    return wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
  });
  expect(overflow).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(E2E.viewport.width);
});

test('不是掌勺者也照样能搜能筛（不按身份门控），且不吃穿手机宽度', async ({ page }) => {
  await clearDecidedSlots(page);
  await openEditor(page);

  // 切到小孩身份：搜索与筛选照旧（spec：不只是掌勺者才能高效加菜）
  await page.getByTestId('identity-chip').click();
  await page.getByTestId('identity-option-xiaobao').click();
  await expect(page.getByTestId('identity-name')).toHaveText('小宝');
  await page.getByTestId('dish-search-input').fill('土豆');
  await expect(page.getByTestId('pick-tudouniuniu')).toBeVisible();
  await page.getByTestId('filter-effort-heavy').click();
  await expect(page.getByTestId('pick-tudouniuniu')).toBeVisible();
  await expect(page.getByTestId('pick-huangmenji')).toBeHidden();
  await expectCountMatches(page);

  // 手机优先：加菜器（输入框 + 三行筛选 + 分组按钮）不许把页面撑宽
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1);
    return wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
  });
  expect(overflow).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(E2E.viewport.width);
});
