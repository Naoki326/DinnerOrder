import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 验收场景 S8（本票）：**买菜清单**——定两餐 → 清单聚合 → 加手工行 → 改餐过期 → 重算（勾选继承、
 * 手工行保留）。
 *
 * 顺带把 **S1 的跨票缺口**补完整（总纲 §1.2 S1 的通过标准含「买菜清单页出现本餐聚合的食材与生重」，
 * 而 #17 的 E2E 只覆盖了推荐那一段）：见下面「S1 补完」那一条——推荐 → 接受 → 清单出现聚合。
 *
 * 文件名排在 `meal.spec.ts` 之后（`s8-grocery` > `meal`，Playwright 按字典序）：那条 spec 断言
 * 「未定餐槽的留痕为空」（`history-empty`），而本 spec 会往窗口内写菜单。这是台账记录过的隐含依赖。
 *
 * 时间基准是真实时钟（E2E 的 webServer 不注入假时钟），所以餐槽 id 一律从 `/api/slots` 现取。
 * 留痕 append-only、清单是**物化**的（会跨用例留状态），所以每条用例开工前先把清单归档掉一张：
 * 归档之后菜单没变就不会再开新的一张（服务端按聚合指纹判定），清场因此是幂等的。
 */
interface SlotJson {
  id: string;
  date: string;
  meal: 'lunch' | 'dinner';
  status: 'undecided' | 'decided';
  menu: { dishes: { recipeId: string; name: string }[] } | null;
}

interface ItemJson {
  id: number;
  kind: 'aggregate' | 'manual';
  ingredientId: string | null;
  name: string;
  grams: number | null;
  checked: boolean;
  needsRelabel: boolean;
  category: string | null;
  sources: { slotId: string; recipeName: string; date: string; meal: string }[];
}

interface ListJson {
  id: number;
  status: 'active' | 'archived';
  stale: boolean;
  /** 枚举短码（服务端不存渲染好的中文，见 #23 评审修复 ②）；界面那句由前端现拼 */
  staleReason: 'menu_changed' | 'cancelled' | 'set_undone' | 'family_rules_changed' | null;
  /** 哪一餐的改动弄过期的；家规类为 null */
  staleSlotId: string | null;
  mealCount: number;
  items: ItemJson[];
  exchangeNote: string;
}

/**
 * 清场：取消窗口内已定的餐槽 + 归档掉进行中的清单。
 *
 * 两步都要：只取消餐槽的话，上一轮留下的清单（含手工行与勾选）会污染下一条用例的断言；
 * 只归档清单的话，已定的餐还挂着。归档本身也证明了「清场是幂等的」——服务端在没有新菜单时
 * 不会再物化一张同内容的清单（按聚合指纹判定，见 domain/grocery.ts）。
 */
async function clearState(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  expect(response.ok()).toBe(true);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    if (!cancelled.ok()) {
      // 取消被「吃剩的」引用的那一餐会联动退回引用方（#22），那个槽可能已被前一个 DELETE 退回了
      const body = (await cancelled.json()) as { error?: string };
      expect(body.error, `取消 ${slot.id} 失败`).toBe('not_decided');
    }
  }
  const grocery = (await (await page.request.get(`${ROOT_URL}/api/grocery`)).json()) as { list: ListJson | null };
  if (grocery.list) {
    const archived = await page.request.post(`${ROOT_URL}/api/grocery/archive`);
    expect(archived.ok()).toBe(true);
  }
  // 家规也复位：本 spec 有一条用例改它（#23 评审修复 ① 的界面回归），而 E2E 服务端是**共享的**
  // （同一文件里后面的用例、以及别的 spec 都读它）。不复位就会漏给后面的用例——
  // 尤其是 `s4-leftover.spec.ts` 里那个「上浮就是家规的那个值」的断言。
  await resetFamilyRules(page);
}

/** 家规回到缺省（午 14 / 晚 21 / 上浮 1.5），保证用例间零共享状态 */
async function resetFamilyRules(page: Page): Promise<void> {
  const response = await page.request.patch(`${ROOT_URL}/api/family-rules`, {
    data: { leftoverUplift: 1.5, lunchCutoffHour: 14, dinnerCutoffHour: 21 },
  });
  expect(response.ok()).toBe(true);
}

test.afterEach(async ({ page }) => {
  await clearState(page);
});

async function listSlots(page: Page, days = 6): Promise<SlotJson[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { slots: SlotJson[] }).slots;
}

async function grocery(page: Page): Promise<ListJson | null> {
  const response = await page.request.get(`${ROOT_URL}/api/grocery`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { list: ListJson | null }).list;
}

async function book(
  page: Page,
  slotId: string,
  dishes: { recipeId: string; keepLeftover?: boolean }[],
  diners: string[] = ['mom', 'dad'],
): Promise<void> {
  const response = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, { data: { diners, dishes } });
  expect(response.ok()).toBe(true);
}

/**
 * 找一组「同日的午餐 + 晚餐、都还没过截止时刻、都未定」的餐槽。
 * 刻意跳过窗口里的第一张午餐（那是 `meal.spec.ts` 的地盘），并且用靠后的日期：
 * 本 spec 要往两餐里写菜单，碰同一个槽会把别人的断言搅乱。
 */
async function findPair(page: Page): Promise<{ lunch: string; dinner: string; date: string }> {
  await clearState(page);
  const slots = await listSlots(page);
  const lunches = slots.filter((slot) => slot.meal === 'lunch' && slot.status === 'undecided');
  expect(lunches.length, '窗口内至少要有一张未定的午餐').toBeGreaterThan(1);
  // 取**最后**一张未定午餐：越往后越不可能与别的 spec（都往前找）撞上
  const lunch = lunches[lunches.length - 1]!;
  const dinner = slots.find((slot) => slot.meal === 'dinner' && slot.date === lunch.date);
  expect(dinner, `${lunch.date} 的晚餐也要在窗口里`).toBeTruthy();
  return { lunch: lunch.id, dinner: dinner!.id, date: lunch.date };
}

function itemByIngredient(list: ListJson, ingredientId: string): ItemJson {
  const item = list.items.find((entry) => entry.ingredientId === ingredientId);
  if (!item) throw new Error(`清单里没有 ${ingredientId}：${list.items.map((entry) => entry.name).join('/')}`);
  return item;
}

test('S8：定两餐 → 清单聚合（含来源与生熟参考）→ 加手工行 → 改餐过期 → 重算（勾选继承、手工行保留）→ 归档', async ({
  page,
}) => {
  const { lunch, dinner } = await findPair(page);

  // 1) 定两餐：排骨出现在两餐里（红烧排骨 150 g + 冬瓜排骨汤 60 g，成人份基准），
  //    外加一道素菜与一道汤里不重的食材
  await book(page, lunch, [{ recipeId: 'hongshaopaigu' }, { recipeId: 'fanqiechaodan' }]);
  await book(page, dinner, [{ recipeId: 'dongguapaigutang' }]);

  // 2) 清单页出现聚合：排骨合成一行、来源点名两餐
  await page.goto(`${ROOT_URL}/grocery`);
  await expect(page.getByTestId('grocery-view')).toBeVisible();
  await expect(page.getByTestId('grocery-status')).toContainText('进行中 · 2 餐');

  const list = (await grocery(page))!;
  const ribs = itemByIngredient(list, 'pork_ribs');
  expect(ribs.sources.map((source) => source.recipeName).sort()).toEqual(['冬瓜排骨汤', '红烧排骨']);
  expect(ribs.grams).toBeGreaterThan(0);

  // 界面上看得见这一行：食材名 + 克数 + 来源说明（S1 通过标准要的「食材与生重」）
  await expect(page.getByTestId(`grocery-name-${ribs.id}`)).toHaveText('猪排骨');
  await expect(page.getByTestId(`grocery-grams-${ribs.id}`)).toContainText(`${ribs.grams} g`);
  await expect(page.getByTestId(`grocery-sources-${ribs.id}`)).toContainText('红烧排骨');
  await expect(page.getByTestId(`grocery-sources-${ribs.id}`)).toContainText('冬瓜排骨汤');
  // 分类分组（服务端按互换表的食材指针分，菜谱食材与互换表能对上的都归位）
  await expect(page.getByTestId('grocery-group-肉禽')).toContainText('猪排骨');
  // 底部生熟换算参考（从互换表现算的一句）
  await expect(page.getByTestId('grocery-exchange-note')).toContainText('生重为准');
  await expect(page.getByTestId('grocery-exchange-note')).toContainText('米生:熟');

  // 3) 勾一行 + 加一条手工行（掌勺者临时要买的）
  await page.getByTestId(`grocery-check-${ribs.id}`).click();
  await expect(page.getByTestId(`grocery-check-${ribs.id}`)).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('grocery-manual-input').fill('一次性手套');
  await page.getByTestId('grocery-manual-add').click();
  await expect(page.getByTestId('grocery-manual')).toContainText('一次性手套');
  await expect(page.getByTestId('grocery-manual')).toContainText('不属于任何菜谱，重算时保留');

  const manualId = (await grocery(page))!.items.find((item) => item.kind === 'manual')!.id;

  // 4) 改餐 → 清单标记过期（警告卡说得出是哪一餐、给了重算按钮）
  await book(page, lunch, [{ recipeId: 'kelejichi' }, { recipeId: 'fanqiechaodan' }]);
  await page.reload();
  await expect(page.getByTestId('grocery-stale')).toBeVisible();
  await expect(page.getByTestId('grocery-stale-reason')).toContainText('过期了');
  await expect(page.getByTestId('grocery-stale-reason')).toContainText('菜单变了');
  // 存的是结构（枚举 + 哪一餐），中文是界面现拼的：那句里还要有那一餐的名字
  const staleList = (await grocery(page))!;
  expect(staleList.staleReason).toBe('menu_changed');
  expect(staleList.staleSlotId).toBe(lunch);
  await expect(page.getByTestId('grocery-stale-reason')).toContainText('午餐');
  // 过期期间行原样留着（勾选与手工行正是重算要继承的东西）
  await expect(page.getByTestId(`grocery-check-${ribs.id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('grocery-manual')).toContainText('一次性手套');

  // 5) 手动重算：过期标记清掉、聚合跟上新菜单（排骨没了、鸡翅来了）、手工行保留
  await page.getByTestId('grocery-recalculate').click();
  await expect(page.getByTestId('grocery-stale')).toBeHidden();
  await expect(page.getByTestId('grocery-list')).toContainText('可乐鸡翅');
  await expect(page.getByTestId('grocery-manual')).toContainText('一次性手套');

  const recalculated = (await grocery(page))!;
  expect(recalculated.stale).toBe(false);
  // 晚餐那道冬瓜排骨汤还在，排骨就还在清单里——但**少了一份**（午餐红烧排骨那 150 g 基准没了）
  expect(itemByIngredient(recalculated, 'pork_ribs').sources.map((source) => source.recipeName)).toEqual([
    '冬瓜排骨汤',
  ]);
  expect(itemByIngredient(recalculated, 'pork_ribs').grams!).toBeLessThan(ribs.grams!);
  // 勾选按食材继承：同一食材（排骨）跟过来
  expect(itemByIngredient(recalculated, 'pork_ribs').checked).toBe(true);
  // 新来的食材（鸡翅）不勾
  const wings = itemByIngredient(recalculated, 'chicken_wings');
  expect(wings.checked).toBe(false);
  // 手工行保留（连 id 与勾选一起）
  expect(recalculated.items.find((item) => item.id === manualId)?.name).toBe('一次性手套');

  // 6) 买完归档：清单卡消失、归档计数看得见，且没有新菜单时不会再冒出一张同内容的清单
  const archivedBefore = ((await (await page.request.get(`${ROOT_URL}/api/grocery`)).json()) as {
    archivedCount: number;
  }).archivedCount;
  await page.getByTestId('grocery-archive').click();
  await expect(page.getByTestId('grocery-empty')).toBeVisible();
  // 归档数 1 份 1 份地长（append-only：历史不删），所以断言相对本次操作
  await expect(page.getByTestId('grocery-archived-count')).toContainText(`已归档 ${archivedBefore + 1} 份`);
  await page.reload();
  await expect(page.getByTestId('grocery-empty')).toBeVisible();
  expect(await grocery(page)).toBeNull();
});

test('S8 补：重算不丢「同一食材跨餐」的勾选（勾选按食材继承，不按行号）', async ({ page }) => {
  const { lunch, dinner } = await findPair(page);
  await book(page, lunch, [{ recipeId: 'hongshaopaigu' }]);
  await page.goto(`${ROOT_URL}/grocery`);

  const before = (await grocery(page))!;
  const ribs = itemByIngredient(before, 'pork_ribs');
  await page.getByTestId(`grocery-check-${ribs.id}`).click();
  await expect(page.getByTestId(`grocery-check-${ribs.id}`)).toHaveAttribute('aria-pressed', 'true');

  // 晚餐又加一道排骨汤 → 过期 → 重算：同一食材的勾选跟过来（行 id 会变，勾选认的是食材）
  await book(page, dinner, [{ recipeId: 'dongguapaigutang' }]);
  await page.reload();
  await expect(page.getByTestId('grocery-stale')).toBeVisible();
  await page.getByTestId('grocery-recalculate').click();
  await expect(page.getByTestId('grocery-stale')).toBeHidden();

  const after = (await grocery(page))!;
  const merged = itemByIngredient(after, 'pork_ribs');
  expect(merged.checked).toBe(true);
  expect(merged.sources).toHaveLength(2);
  await expect(page.getByTestId(`grocery-check-${merged.id}`)).toHaveAttribute('aria-pressed', 'true');
});

test('S8 补：一餐都没定时，也能先写手工行（不凭空造空清单，但动手写就建一张）', async ({ page }) => {
  await clearState(page);
  await page.goto(`${ROOT_URL}/grocery`);

  // 没定过餐：清单空态（不凭空造一张空的），但手工行卡恒在（照原型 v1）
  await expect(page.getByTestId('grocery-empty')).toBeVisible();
  await expect(page.getByTestId('grocery-list')).toBeHidden();
  await expect(page.getByTestId('grocery-manual')).toBeVisible();

  // 写一条手工行：服务端把清单建起来，界面跟着长出清单卡
  await page.getByTestId('grocery-manual-input').fill('酱油');
  await page.getByTestId('grocery-manual-add').click();
  await expect(page.getByTestId('grocery-manual')).toContainText('酱油');
  await expect(page.getByTestId('grocery-empty')).toBeHidden();

  const list = (await grocery(page))!;
  expect(list.mealCount).toBe(0);
  expect(list.items.map((item) => item.name)).toEqual(['酱油']);
});

test('S8 补：生重合计 ≥500 g 时另给「斤」（菜场论斤问价），克数照旧写着', async ({ page }) => {
  const { lunch, dinner } = await findPair(page);
  // 全员用餐：猪排骨跨两餐合计必定过 500 g（150 + 60 的成人份基准 × Σ折算系数）
  const diners = ['mom', 'dad', 'dabao', 'xiaobao'];
  await book(page, lunch, [{ recipeId: 'hongshaopaigu' }], diners);
  await book(page, dinner, [{ recipeId: 'dongguapaigutang' }], diners);

  await page.goto(`${ROOT_URL}/grocery`);
  const list = (await grocery(page))!;
  const ribs = itemByIngredient(list, 'pork_ribs');
  expect(ribs.grams!).toBeGreaterThanOrEqual(500);
  // 换算过的数不取代原值：斤是附加的读法，生重克数照旧写在旁边
  await expect(page.getByTestId(`grocery-grams-${ribs.id}`)).toContainText('斤');
  await expect(page.getByTestId(`grocery-grams-${ribs.id}`)).toContainText(`${ribs.grams} g`);
});

test('S8 补：清单页不吃手机宽度（总纲「手机优先」）', async ({ page }) => {
  const { lunch, dinner } = await findPair(page);
  // 挑几道长名字/长来源的菜，把最坏情况的宽度撑出来
  await book(page, lunch, [{ recipeId: 'yumihuluobogutang' }, { recipeId: 'shangtangwawacai' }]);
  await book(page, dinner, [{ recipeId: 'chongcaohuazhengji' }, { recipeId: 'mapodoufu' }]);

  await page.goto(`${ROOT_URL}/grocery`);
  await expect(page.getByTestId('grocery-list')).toBeVisible();

  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => `${element.tagName}.${element.className}`)
      .slice(0, 5),
  );
  expect(overflow).toEqual([]);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});

/**
 * 家规改动 → 过期警告卡（#23 评审修复 ①、② 的界面回归）。
 *
 * 服务端存的是**结构**（原因枚举 + 哪一餐），那句人话是界面现拼的——这条用例就是那条链路的端到端证据：
 * 改家规 → 服务端标过期（`family_rules_changed`）→ 页面上出现警告卡且说清是家规变了 → 重算清掉。
 * 不依赖墙上时钟：上浮系数一改就一定会让聚合口径变（有没真正生效的引用是另一回事，
 * 那是 `s4-leftover.spec.ts` 与本票单测 `grocery.test.ts` 的地盘）。
 */
test('S8 补：改家规（上浮系数）→ 进行中的清单在页面上说过期了，重算后清掉', async ({ page }) => {
  const { lunch } = await findPair(page);
  await book(page, lunch, [{ recipeId: 'hongshaopaigu' }]);
  await page.goto(`${ROOT_URL}/grocery`);
  await expect(page.getByTestId('grocery-list')).toBeVisible();
  await expect(page.getByTestId('grocery-stale')).toBeHidden();

  // 改家规：上浮系数变 → 同一份菜单的聚合克数就变了，清单必须标过期（不能静默）
  const patched = await page.request.patch(`${ROOT_URL}/api/family-rules`, { data: { leftoverUplift: 2 } });
  expect(patched.ok()).toBe(true);
  await page.reload();

  await expect(page.getByTestId('grocery-stale')).toBeVisible();
  await expect(page.getByTestId('grocery-stale-reason')).toContainText('家规');
  const staleList = (await grocery(page))!;
  expect(staleList.staleReason).toBe('family_rules_changed');
  // 家规没有「哪一餐」：那句里不编造一个槽（schema 上也成对）
  expect(staleList.staleSlotId).toBeNull();

  await page.getByTestId('grocery-recalculate').click();
  await expect(page.getByTestId('grocery-stale')).toBeHidden();
  expect((await grocery(page))!.stale).toBe(false);
});

/**
 * S1 的跨票缺口（台账「归属 #23」）：§1.2 S1 的通过标准是「推荐 → 一键接受 → **买菜清单页出现
 * 本餐聚合的食材与生重**」，而 #17 的 E2E 只走到接受为止。这里把最后一段补上。
 */
test('S1 补完：给我推荐 → 一键接受 → 买菜清单页出现本餐聚合的食材与生重', async ({ page }) => {
  await clearState(page);
  await page.goto(`${ROOT_URL}/`);

  // 先记下这一张卡的餐槽 id：接受之后英雄卡会移到**下一张**未定餐槽，
  // 再用 `empty-slot` 取 id 就会拿到别人（这正是推荐 spec 里踩过的同一个坑）
  const heroSlotId = (await page.getByTestId('empty-slot').getAttribute('data-slot-id'))!;
  expect(heroSlotId).toMatch(/^\d{4}-\d{2}-\d{2}:(lunch|dinner)$/);

  // 显式触发 → 面板出现
  await page.getByTestId('recommend-button').click();
  await expect(page.getByTestId('recommendation-panel')).toBeVisible({ timeout: 15_000 });
  const dishCount = await page.getByTestId('recommendation-dishes').locator('> div').count();
  expect(dishCount).toBeGreaterThanOrEqual(4);

  // 一键接受 → 这一张卡变已定（按 slot id 定位，不是按“当前英雄卡”）
  await page.getByTestId('accept-recommendation').click();
  const card = page.locator(`[data-slot-id="${heroSlotId}"]`).first();
  await expect(card).toContainText('已定', { timeout: 15_000 });

  // 推荐那一段的菜品（服务端读数）——它们的主料必须出现在清单里，且克数是**该餐逐食材之和**
  // （同一食材可能出现在两道菜里：红烧排骨与冬瓜排骨汤都有猪排骨）
  const slot = (await (await page.request.get(`${ROOT_URL}/api/slots/${heroSlotId}`)).json()) as {
    slot: {
      menu: { dishes: { name: string }[] } | null;
      portion: {
        dishes: { ingredients: { ingredientId: string; name: string; grams: number }[] }[];
      } | null;
    };
  };
  const expected = new Map<string, { name: string; grams: number }>();
  for (const dish of slot.slot.portion?.dishes ?? []) {
    for (const ingredient of dish.ingredients) {
      const existing = expected.get(ingredient.ingredientId);
      if (existing) existing.grams += ingredient.grams;
      else expected.set(ingredient.ingredientId, { name: ingredient.name, grams: ingredient.grams });
    }
  }
  expect(expected.size).toBeGreaterThan(0);

  // 买菜清单页：本餐的食材与生重真的聚合进来了（S1 的最后一段）
  await page.getByRole('link', { name: /买菜/ }).click();
  await expect(page).toHaveURL(`${ROOT_URL}/grocery`);
  await expect(page.getByTestId('grocery-list')).toBeVisible();

  const list = (await grocery(page))!;
  expect(list.mealCount).toBe(1);
  for (const [ingredientId, ingredient] of expected) {
    const item = itemByIngredient(list, ingredientId);
    expect(item.grams, `${ingredient.name} 的克数应与份量引擎的合计一致`).toBe(ingredient.grams);
    await expect(page.getByTestId(`grocery-name-${item.id}`)).toHaveText(ingredient.name);
  }
  // 生熟换算参考也在（S8 的通过标准含「附生熟换算参考」）
  await expect(page.getByTestId('grocery-exchange-note')).toContainText('生重为准');
});
