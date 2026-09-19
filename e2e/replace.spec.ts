import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 验收场景 S2（换菜）：打开已定的一餐 → 对某道菜点「换」→ 看到 3 个候选（各带一句理由、
 * 外部补位菜标「没做过」、被忌口排除的同位菜带原因）→「换它」→ 保存 → 留痕里多一条「改餐」；
 * 「再换一个」换出新的一批（同一会话内累积排除）；「换一整套」后出现「撤销」，撤销回到上一套。
 *
 * LLM 是**确定性 fake**（`server/src/e2e-server.ts` 注入）：它解析 prompt 里的【同位候选池】
 * 做一次合法挑选，所以本测试同时也在验「池子与忌口过滤对了没有」——真模型做不到这种断言。
 *
 * 时间基准是真实时钟（webServer 不注入假时钟），所以餐槽 id 一律现取，不写死日期。
 */
interface SlotJson {
  id: string;
  status: 'undecided' | 'decided';
  canUndoSet: boolean;
  menu: { dishes: { recipeId: string; name: string }[] } | null;
}

interface CandidatesJson {
  replacing: { recipeId: string; name: string; kind: string };
  candidates: { recipeId: string; name: string; kind: string; origin: 'family' | 'external'; reason: string | null }[];
  excluded: { recipeId: string; name: string; reason: string }[];
  relaxed: 'none' | 'dedupe' | 'session';
  llm: { format: string; promptVersion: string; degraded: boolean };
  notes: string[];
}

/** 清场：窗口内已定的餐槽全取消（各用例都要一张干净的未定大卡） */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
  }
}

async function nextUndecidedSlot(page: Page): Promise<string> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  const slot = slots.find((item) => item.status === 'undecided');
  if (!slot) throw new Error('窗口内没有未定的餐槽，清场逻辑出问题了');
  return slot.id;
}

async function historyOf(page: Page, id: string): Promise<{ type: string; source: string }[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${id}`);
  return ((await response.json()) as { history: never[] }).history;
}

async function candidatesOf(
  page: Page,
  slotId: string,
  body: Record<string, unknown>,
): Promise<CandidatesJson> {
  const response = await page.request.post(`${ROOT_URL}/api/slots/${slotId}/candidates`, { data: body });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { candidates: CandidatesJson }).candidates;
}

/** 面板上现在列着哪几个候选（按 DOM 里的 testid 读，而不是看服务端） */
async function shownIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="candidate-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid') ?? '')
        // 面板容器 `candidate-panel` 与几个衍生标记（external-/reason-/excluded-）不算候选项
        .filter((id) => /^candidate-(?!panel$|external-|reason-|excluded-)/.test(id))
        .map((id) => id.replace(/^candidate-/, '')),
    );
}

/**
 * 记下界面发给 /candidates 的请求体。
 * `exclude` 是**会话排除集**的线上形状（总纲 §4：会话状态在客户端），所以断言它
 * 就是在断言「界面认不认得这一个换菜会话」——这比猜池子排序稳健（月份一变排序就变）。
 */
function recordCandidateRequests(page: Page): { replacing: string; dishes?: string[]; exclude?: string[] }[] {
  const bodies: { replacing: string; dishes?: string[]; exclude?: string[] }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/candidates')) {
      bodies.push(request.postDataJSON() as { replacing: string; dishes?: string[]; exclude?: string[] });
    }
  });
  return bodies;
}

/** 备一桌已定的晚餐：一道荤、一道素、一道汤（用 API 造数据，走的就是定餐那条真实路径） */
async function bookDinner(page: Page, slotId: string): Promise<void> {
  const response = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: {
      diners: ['mom', 'dad', 'dabao', 'xiaobao'],
      dishes: [{ recipeId: 'hongshaopaigu' }, { recipeId: 'suanrongcaixin' }, { recipeId: 'dongguapaigutang' }],
    },
  });
  expect(response.ok()).toBe(true);
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

test('换单道：3 个候选各带理由、忌口排除原因可见，换掉后保存成「改餐」（S2）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  await bookDinner(page, slotId);

  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  const editor = page.getByTestId('slot-view');
  await expect(editor).toBeVisible();

  // 显式打开：候选面板在点了「换」之前不存在（不自动生成）
  await expect(page.getByTestId('candidate-panel')).toBeHidden();
  await page.getByTestId('swap-hongshaopaigu').click();
  const panel = page.getByTestId('candidate-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // 服务端那一份与界面同源：3 个候选、各带一句理由、都在荤位上、都不是同桌已有的菜
  const candidates = await candidatesOf(page, slotId, { replacing: 'hongshaopaigu' });
  expect(candidates.candidates).toHaveLength(3);
  expect(candidates.candidates.every((item) => (item.reason ?? '').length > 0)).toBe(true);
  expect(candidates.candidates.every((item) => item.kind === 'meat')).toBe(true);
  expect(candidates.candidates.map((item) => item.recipeId)).not.toContain('hongshaopaigu');
  expect(candidates.candidates.map((item) => item.recipeId)).not.toContain('suanrongcaixin');
  expect(candidates.llm.format).toBe('json_schema');

  // 忌口排除原因展示（spec §2.3 的硬要求）：小宝忌虾 → 白灼虾带原因划掉
  const excluded = page.getByTestId('candidate-excluded-baizhuoxia');
  await expect(excluded).toContainText('白灼虾');
  await expect(excluded).toContainText('小宝忌虾');

  // 三个候选行都在界面上，每行一个「换它」
  const first = candidates.candidates[0]!;
  const row = page.getByTestId(`candidate-${first.recipeId}`);
  await expect(row).toContainText(first.name);
  await expect(row).toContainText(first.reason!);
  await page.getByTestId(`use-candidate-${first.recipeId}`).click();

  // 「换它」只改本地草稿：面板收起、这道菜已经在「这一餐的菜」里了
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('chosen-dishes')).toContainText(first.name);

  // 保存 → 留痕里是「改餐」（replace + manual）
  await page.getByTestId('save-slot').click();
  await expect(page).toHaveURL(new RegExp(`^${ROOT_URL}/$`), { timeout: 15_000 });

  const history = await historyOf(page, slotId);
  expect(history.at(-1)?.type).toBe('replace');
  expect(history.at(-1)?.source).toBe('manual');

  const saved = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot } = (await saved.json()) as { slot: SlotJson };
  expect(slot.menu?.dishes.map((dish) => dish.recipeId)).toEqual([
    first.recipeId,
    'suanrongcaixin',
    'dongguapaigutang',
  ]);
});

test('「再换一个」在同一会话内累积排除已出示候选，池干时明确说明放宽（S2）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  await bookDinner(page, slotId);

  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await page.getByTestId('swap-hongshaopaigu').click();
  const panel = page.getByTestId('candidate-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // 等面板真的把候选列出来（面板可见 ≠ 候选已到；第一帧还只有「正在找候选…」）
  await expect.poll(async () => (await shownIds(page)).length, { timeout: 15_000 }).toBe(3);
  const firstIds = await shownIds(page);

  // 「再换一个」：同一会话内已出示的不再出现（界面上真的换了一批，不是发了请求就算）
  await page.getByTestId('another-candidate').click();
  await expect
    .poll(async () => (await shownIds(page)).join(','), { timeout: 15_000 })
    .not.toBe(firstIds.join(','));
  const secondIds = await shownIds(page);
  expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

  // 池干放宽：把所有同位菜都排除掉，服务端明说放宽了、界面也把原因说出来
  const dry = await candidatesOf(page, slotId, {
    replacing: 'hongshaopaigu',
    exclude: [
      ...firstIds,
      ...secondIds,
      'kelejichi',
      'qingzhengluyu',
      'tudouniuniu',
      'tangculiji',
      'chongcaohuazhengji',
      'huangmenji',
      'xiangguhuaji',
      'gongbaojiding',
      'huiguorou',
      'fanqieniunan',
      'baizhuoxia',
    ],
  });
  expect(dry.relaxed).toBe('session');
  expect(dry.notes.join(' ')).toMatch(/出示过|用完/);
  // 放宽也不放回忌口菜（白灼虾永远不在候选里）
  expect(dry.candidates.map((item) => item.recipeId)).not.toContain('baizhuoxia');
});

test('会话排除的初值把「被换掉的那道菜」带进来（spec §2.3：被换掉的 + 已出示的累积排除）', async ({
  page,
}) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  await bookDinner(page, slotId);

  // 记下界面发给 /candidates 的请求体：`exclude` 就是「这一轮换菜会话」的线上形状
  const requests = recordCandidateRequests(page);

  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await page.getByTestId('swap-hongshaopaigu').click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await shownIds(page)).length, { timeout: 15_000 }).toBe(3);
  // 会话刚开始：没有可排除的东西
  expect(requests[0]?.exclude ?? []).toEqual([]);

  // 「换它」换掉红烧排骨
  const replacement = (await shownIds(page))[0]!;
  await page.getByTestId(`use-candidate-${replacement}`).click();
  await expect(page.getByTestId(`chosen-${replacement}`)).toBeVisible();

  // 再对**同一道位置**（现在是换过的那道）发起候选：被换掉的红烧排骨必须在排除集里——
  // 它已经不在草稿菜单里了，靠「当前菜单集合」挡不住它
  await page.getByTestId(`swap-${replacement}`).click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await shownIds(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(async () => requests.length, { timeout: 15_000 }).toBeGreaterThan(1);

  const second = requests.at(-1)!;
  expect(second.replacing).toBe(replacement);
  // 两类累积排除合成一个集合：刚被换掉的红烧排骨 + 上一批已出示过的候选
  expect(second.exclude).toContain('hongshaopaigu');
  expect(second.exclude?.length).toBeGreaterThanOrEqual(2);
  // 界面上也不会再把刚换掉的那道摆出来
  expect(await shownIds(page)).not.toContain('hongshaopaigu');

  // 配对对照（确定性，不依赖池子排序）：把其他荤菜都排除掉，严格档里就只剩
  // 「刚被换掉的那道」与另一道。被换掉的那道已经不在草稿菜单里了，
  // 靠「当前菜单集合」挡不住它，只有会话排除集能挡。
  const draft = second.dishes!;
  const MEAT = [
    'hongshaopaigu',
    'kelejichi',
    'qingzhengluyu',
    'tudouniuniu',
    'tangculiji',
    'chongcaohuazhengji',
    'huangmenji',
    'xiangguhuaji',
    'gongbaojiding',
    'huiguorou',
    'fanqieniunan',
  ];
  const otherMeats = MEAT.filter((id) => id !== replacement && id !== 'hongshaopaigu');
  const keep = otherMeats[0]!;
  const excludedMeats = otherMeats.slice(1);

  // 不放「被换掉的那道」：它就又回到候选里了（严格档里就那两道）
  const control = await candidatesOf(page, slotId, {
    replacing: replacement,
    dishes: draft,
    exclude: excludedMeats,
  });
  expect(control.relaxed).toBe('none');
  expect(control.candidates.map((item) => item.recipeId)).toContain('hongshaopaigu');
  expect(control.candidates.map((item) => item.recipeId)).toContain(keep);

  // 放进去：被换掉的红烧排骨不再出现，而且严格档没被放宽（不是靠「池干后放宽」把它挤掉的）
  const blocked = await candidatesOf(page, slotId, {
    replacing: replacement,
    dishes: draft,
    exclude: [...excludedMeats, 'hongshaopaigu'],
  });
  expect(blocked.relaxed).toBe('none');
  expect(blocked.candidates.map((item) => item.recipeId)).not.toContain('hongshaopaigu');
  expect(blocked.candidates.map((item) => item.recipeId)).toContain(keep);
});

test('「换一整套」的重挂载不丢换菜会话的累积排除（spec §2.3）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);

  // 先问一次 fake 会挑哪一套（确定性），再手动定一套：被换掉的菜选一道**不在这套里**的荤菜
  // ——换一整套之后它必然不在菜单上，只有会话排除集能把它挡在候选之外
  // （还在菜单上的话「同桌已有」那一层就把它挡住了，验不到会话排除）
  const preview = await page.request.post(`${ROOT_URL}/api/slots/${slotId}/recommendation`, { data: {} });
  expect(preview.ok()).toBe(true);
  const recommended = ((await preview.json()) as {
    recommendation: { dishes: { recipeId: string; kind: string }[] };
  }).recommendation.dishes;
  const recommendedIds = recommended.map((dish) => dish.recipeId);
  const found = [
    'hongshaopaigu',
    'kelejichi',
    'qingzhengluyu',
    'tudouniuniu',
    'tangculiji',
    'chongcaohuazhengji',
    'huangmenji',
  ].find((id) => !recommendedIds.includes(id));
  expect(found).toBeTruthy();
  const swappedAway = found!;

  const booked = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: {
      diners: ['mom', 'dad', 'dabao', 'xiaobao'],
      dishes: [{ recipeId: swappedAway }, { recipeId: 'suanrongcaixin' }, { recipeId: 'dongguapaigutang' }],
    },
  });
  expect(booked.ok()).toBe(true);

  // 记下界面发给 /candidates 的请求体：`exclude` 就是会话排除集的线上形状
  const requests = recordCandidateRequests(page);

  await page.goto(`${ROOT_URL}/slot/${slotId}`);

  // 1) 同一页里换掉那道菜（只改本地草稿，服务端菜单还是刚定的那一套）
  await page.getByTestId(`swap-${swappedAway}`).click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await shownIds(page)).length, { timeout: 15_000 }).toBe(3);
  const replacement = (await shownIds(page))[0]!;
  await page.getByTestId(`use-candidate-${replacement}`).click();
  await expect(page.getByTestId(`chosen-${replacement}`)).toBeVisible();
  expect(requests.at(-1)?.exclude ?? []).toEqual([]);

  // 2) 「换一整套」：服务端菜单变了 → SlotEditor 按 `key` 重挂载。会话排除集挂在外层
  // SlotView，不随这次重挂载丢掉。
  // （「保存」会 navigate('/') —— 离开这一页就是离开这个换菜会话，排除集就该清了；
  //   能触发重挂载而不离开页面的就是「换一整套」与「撤销」。）
  await page.getByTestId('replace-set').click();
  await expect(page.getByTestId('undo-set')).toBeVisible({ timeout: 15_000 });

  // 3) 再对同一荤位发起换菜：先前被换掉的那道不在新菜单里，只有会话排除集能挡住它
  const targetFound = recommended.find((dish) => dish.kind === 'meat');
  expect(targetFound).toBeTruthy();
  await page.getByTestId(`swap-${targetFound!.recipeId}`).click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await shownIds(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);

  const afterRemount = requests.at(-1)!;
  expect(afterRemount.exclude).toContain(swappedAway);
  expect(await shownIds(page)).not.toContain(swappedAway);
});

test('「换一整套」重新生成整餐并可撤销回上一套（S2）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);

  // 先要一份推荐得知 fake 会挑哪一套，再手动定一套**与之不同**的菜：
  // fake 是确定性的，直接对同一套菜单「换一整套」会得到相同的集合（内容没变就不追事件）
  const preview = await page.request.post(`${ROOT_URL}/api/slots/${slotId}/recommendation`, { data: {} });
  expect(preview.ok()).toBe(true);
  const recommended = ((await preview.json()) as { recommendation: { dishes: { recipeId: string }[] } })
    .recommendation.dishes.map((dish) => dish.recipeId);

  const manual = ['kelejichi', 'culutudousi', 'dongguapaigutang'].filter((id) => !recommended.includes(id));
  expect(manual.length).toBeGreaterThanOrEqual(2);
  const response = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: { diners: ['mom', 'dad', 'dabao', 'xiaobao'], dishes: manual.map((recipeId) => ({ recipeId })) },
  });
  expect(response.ok()).toBe(true);

  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  // 还没换过套：撤销按钮不出现（常亮的按钮会让人以为有东西可撤）
  await expect(page.getByTestId('undo-set')).toBeHidden();

  await page.getByTestId('replace-set').click();
  await expect(page.getByTestId('undo-set')).toBeVisible({ timeout: 15_000 });

  // 整套确实换了、留痕是 replace_set + recommendation，且服务端说可以撤销
  const swapped = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot: afterSwap } = (await swapped.json()) as { slot: SlotJson };
  expect(afterSwap.menu?.dishes.map((dish) => dish.recipeId)).toEqual(recommended);
  expect(afterSwap.canUndoSet).toBe(true);
  const history = await historyOf(page, slotId);
  expect(history.at(-1)?.type).toBe('replace_set');
  expect(history.at(-1)?.source).toBe('recommendation');

  // 撤销：回到刚才那一套，撤销本身也是一条留痕（replace_set + manual），且不再可撤销
  await page.getByTestId('undo-set').click();
  await expect
    .poll(async () => {
      const current = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
      const { slot } = (await current.json()) as { slot: SlotJson };
      return slot.menu?.dishes.map((dish) => dish.recipeId).join(',') ?? '';
    }, { timeout: 15_000 })
    .toBe(manual.join(','));

  const afterUndo = await historyOf(page, slotId);
  expect(afterUndo.at(-1)?.type).toBe('replace_set');
  expect(afterUndo.at(-1)?.source).toBe('manual');
  const finalSlot = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  expect(((await finalSlot.json()) as { slot: SlotJson }).slot.canUndoSet).toBe(false);
  await expect(page.getByTestId('undo-set')).toBeHidden();
});

test('外部补位候选在面板上标「没做过」（S6 落进换菜这条路）', async ({ page }) => {
  await clearDecidedSlots(page);

  // 造出「荤位家庭池不足 3 道」的真实处境：给爸爸加一份忌口，只留牛腩那道荤菜。
  // 用 API 改画像而不是 mock 内部状态：走的就是家人画像那条路。
  const avoid = ['pork_ribs', 'chicken_wings', 'chicken_legs', 'seabass', 'pork_tenderloin', 'shrimp'];
  const patched = await page.request.patch(`${ROOT_URL}/api/members/dad`, { data: { avoid } });
  expect(patched.ok()).toBe(true);

  try {
    const slotId = await nextUndecidedSlot(page);
    await bookDinner(page, slotId);

    await page.goto(`${ROOT_URL}/slot/${slotId}`);
    await page.getByTestId('swap-hongshaopaigu').click();
    await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });

    // 补位菜来自外部草稿池 → 面板上显著标「没做过」
    const badge = page.locator('[data-testid^="candidate-external-"]').first();
    await expect(badge).toContainText('没做过');

    // 服务端那一份与之对应（不是界面自己编的标记）
    const candidates = await candidatesOf(page, slotId, { replacing: 'hongshaopaigu' });
    expect(candidates.candidates.some((item) => item.origin === 'external')).toBe(true);
  } finally {
    // 复原画像（后续测试与冒烟都靠种子态；avoid 只换这一块，loves 不动）
    await page.request.patch(`${ROOT_URL}/api/members/dad`, { data: { avoid: [] } });
  }
});

test('候选面板不吃手机宽度（总纲「手机优先」）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  await bookDinner(page, slotId);

  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await page.getByTestId('swap-hongshaopaigu').click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});

test('整餐推荐面板上也能下钻换单道，换掉后接受的是换过的那一份（spec §2.3）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);

  await page.getByTestId('recommend-button').click();
  const panel = page.getByTestId('recommendation-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // 推荐是草稿（不落库）：这时餐槽还是未定，服务端手里没有这份菜单
  const hero = page.getByTestId('empty-slot');
  const slotId = (await hero.getAttribute('data-slot-id'))!;
  const before = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  expect(((await before.json()) as { slot: SlotJson }).slot.status).toBe('undecided');

  // 推荐面板上的一道菜点「换」→ 候选面板出来（走的还是同一条 /candidates + 草稿菜单）
  const firstDish = panel.locator('[data-testid^="recommend-dish-"]').first();
  const dishId = (await firstDish.getAttribute('data-testid'))!.replace('recommend-dish-', '');
  await page.getByTestId(`recommend-swap-${dishId}`).click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });

  const candidates = await candidatesOf(page, slotId, {
    replacing: dishId,
    dishes: (await panel.locator('[data-testid^="recommend-dish-"]').evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute('data-testid') ?? '').replace('recommend-dish-', '')),
    )),
  });
  const replacement = candidates.candidates[0]!;
  await page.getByTestId(`use-candidate-${replacement.recipeId}`).click();

  // 换掉的只是这份草稿：面板上已经是新菜（旧菜不在推荐面板里了）
  await expect(panel).toContainText(replacement.name);
  await expect(page.getByTestId(`recommend-dish-${dishId}`)).toBeHidden();

  // 接受之后落库的是换过之后的那一份（未定的餐槽也走同一条 PUT 路）
  await page.getByTestId('accept-recommendation').click();
  await expect
    .poll(async () => {
      const saved = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
      const { slot } = (await saved.json()) as { slot: SlotJson };
      return slot.menu?.dishes.map((dish) => dish.recipeId).join(',') ?? '';
    }, { timeout: 15_000 })
    .toContain(replacement.recipeId);
});

test('推荐面板上的「换一整套」可撤销回上一份草稿（spec §2.3 的可反悔）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);

  await page.getByTestId('recommend-button').click();
  const panel = page.getByTestId('recommendation-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // 首次推荐没有可撤销的东西：按钮不出现（常亮的按钮会让人以为有东西可撤）
  await expect(page.getByTestId('undo-recommendation')).toBeHidden();

  // 先在草稿上换掉一道菜（面板里的「换」→ 候选 → 换它），草稿与 fake 的默认那一套就此不同
  const dishId = (await panel
    .locator('[data-testid^="recommend-dish-"]')
    .first()
    .getAttribute('data-testid'))!.replace('recommend-dish-', '');
  await page.getByTestId(`recommend-swap-${dishId}`).click();
  await expect(page.getByTestId('candidate-panel')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await shownIds(page)).length, { timeout: 15_000 }).toBe(3);
  const replacement = (await shownIds(page))[0]!;
  await page.getByTestId(`use-candidate-${replacement}`).click();
  await expect(page.getByTestId(`recommend-dish-${replacement}`)).toBeVisible();

  // 「换一整套」：重新生成——fake 是确定性的，所以回到默认那一套（换过的那道又回来了）
  await page.getByTestId('recommend-button').click();
  await expect(page.getByTestId('undo-recommendation')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`recommend-dish-${dishId}`)).toBeVisible();
  await expect(page.getByTestId(`recommend-dish-${replacement}`)).toBeHidden();

  // 撤销：回到换之前那一份草稿（含换过的菜、不含换掉的那道），且只走一步（没有更早的可退）
  await page.getByTestId('undo-recommendation').click();
  await expect(page.getByTestId(`recommend-dish-${replacement}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`recommend-dish-${dishId}`)).toBeHidden();
  await expect(page.getByTestId('undo-recommendation')).toBeHidden();

  // 这一路都只是草稿：餐槽仍然未定（草稿没落库，所以「上一套」只能在前端留住）
  const hero = page.getByTestId('empty-slot');
  const slotId = (await hero.getAttribute('data-slot-id'))!;
  const after = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  expect(((await after.json()) as { slot: SlotJson }).slot.status).toBe('undecided');
});
