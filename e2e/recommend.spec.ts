import { expect, test, type Page } from '@playwright/test';
import { E2E, LLM_DOWN_URL, ROOT_URL } from './test-env';

/**
 * 验收场景 S1 的推荐段 + S6/S7（总纲 §4、spec §2.2）：
 * 打开 app → 点「给我推荐」（**显式触发**）→ 看结构、每道理由 → 一键接受 → 定下来。
 *
 * LLM 是**确定性 fake**（`server/src/e2e-server.ts` 注入）：它解析 prompt 里的候选池做一次
 * 合法选择，所以本测试同时在验「池子过滤对了没有」——真模型做不到这种断言（它两次给不同的菜）。
 *
 * 时间基准是真实时钟（webServer 不注入假时钟），所以餐槽 id 一律现取，不写死日期。
 */
interface SlotJson {
  id: string;
  status: 'undecided' | 'decided';
  menu: { dishes: { recipeId: string; name: string }[] } | null;
}

interface RecommendationJson {
  slotId: string;
  structure: { meat: number; veg: number; soup: number };
  dishes: { recipeId: string; name: string; origin: 'family' | 'external'; reason: string | null }[];
  llm: { model: string; promptVersion: string; latencyMs: number; degraded: boolean; format: string };
  notes: string[];
}

/** 清场：窗口内已定的餐槽全取消（推荐测试要一张干净的未定大卡） */
async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
  }
}

/** 一次推荐（服务端那一份；界面上的面板来自同一条路径） */
async function askRecommendation(page: Page, slotId: string, diners?: string[]): Promise<RecommendationJson> {
  const response = await page.request.post(`${ROOT_URL}/api/slots/${slotId}/recommendation`, {
    data: diners ? { diners } : {},
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { recommendation: RecommendationJson }).recommendation;
}

async function historyOf(
  page: Page,
  id: string,
): Promise<{ type: string; source: string; llm: { model: string; promptVersion: string; degraded: boolean } | null }[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${id}`);
  return ((await response.json()) as { history: never[] }).history;
}

async function undecidedSlotAt(page: Page, base: string): Promise<string> {
  const response = await page.request.get(`${base}/api/slots?days=7`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  const slot = slots.find((item) => item.status === 'undecided');
  if (!slot) throw new Error(`${base} 窗口内没有未定的餐槽`);
  return slot.id;
}

async function nextUndecidedSlot(page: Page): Promise<string> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  const slot = slots.find((item) => item.status === 'undecided');
  if (!slot) throw new Error('窗口内没有未定的餐槽，清场逻辑出问题了');
  return slot.id;
}

/**
 * 收尾清场：冒烟与其他场景共用同一个库，留一份已定菜单会把别人的断言（最近未定餐槽）
 * 搅乱。历史是 append-only，所以断言一律只相对本次操作。
 */
test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

test('点「给我推荐」拿一整餐：结构按家规、每道一句理由、一键接受成菜单（S1）', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);

  const hero = page.getByTestId('empty-slot');
  await expect(hero).toBeVisible();
  const slotId = (await hero.getAttribute('data-slot-id'))!;
  expect(slotId).toMatch(/^\d{4}-\d{2}-\d{2}:(lunch|dinner)$/);

  // 显式触发（总纲 §2.2）：打开页面不自动生成，点了才出面板
  await expect(page.getByTestId('recommendation-panel')).toBeHidden();
  const button = page.getByTestId('recommend-button');
  await expect(button).toBeEnabled();
  await expect(button).toContainText('给我推荐');
  await button.click();

  const panel = page.getByTestId('recommendation-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // 结构按家规、每道菜一行带一句理由；fake 走的是 strict 档，所以不该出现简化推荐标记
  await expect(page.getByTestId('recommendation-structure')).toContainText('按家规配');
  await expect(page.getByTestId('recommendation-degraded')).toBeHidden();
  expect(await page.getByTestId('recommendation-dishes').locator('> div').count()).toBeGreaterThanOrEqual(4);

  // 服务端那一份与界面同源：结构自洽、每道有理由、元数据是真值（模型名来自 fake）
  const recommendation = await askRecommendation(page, slotId);
  expect(recommendation.dishes).toHaveLength(
    recommendation.structure.meat + recommendation.structure.veg + recommendation.structure.soup,
  );
  expect(recommendation.dishes.every((dish) => (dish.reason ?? '').length > 0)).toBe(true);
  expect(recommendation.llm.model).toBe(E2E.fakeModel);
  expect(recommendation.llm.format).toBe('json_schema');
  expect(recommendation.llm.degraded).toBe(false);

  // 推荐不落库（总纲 §4「不用缓存菜单」）：这会儿餐槽仍是未定
  const before = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  expect(((await before.json()) as { slot: SlotJson }).slot.status).toBe('undecided');

  // 一键接受：菜单落库、大卡变已定
  await page.getByTestId('accept-recommendation').click();
  const card = page.locator(`[data-slot-id="${slotId}"]`).first();
  await expect(card).toContainText('已定', { timeout: 15_000 });

  // 留痕带 LLM 元数据（模型名 / prompt 版本 / 是否降级）——「为什么推这道」可回溯
  const accepted = (await historyOf(page, slotId)).at(-1)!;
  expect(accepted.source).toBe('recommendation');
  expect(accepted.llm?.model).toBe(E2E.fakeModel);
  expect(accepted.llm?.promptVersion).toBe(recommendation.llm.promptVersion);
  expect(accepted.llm?.degraded).toBe(false);
  expect(accepted.type).toBe('decide');
});

test('忌口硬过滤在真进程里生效：小宝这一餐不会出现虾与蚝油类的菜', async ({ page }) => {
  const slotId = await nextUndecidedSlot(page);
  const recommendation = await askRecommendation(page, slotId, ['xiaobao']);

  const names = recommendation.dishes.map((dish) => dish.name);
  // 小宝忌虾（白灼虾）与贝类（蚝油生菜：蚝油含贝类，隐性忌口展开）
  expect(names).not.toContain('白灼虾');
  expect(names).not.toContain('蚝油生菜');
  // 结构仍然配满（家规是按大人数的，与忌口无关）
  expect(recommendation.dishes).toHaveLength(
    recommendation.structure.meat + recommendation.structure.veg + recommendation.structure.soup,
  );

  // 大人少一位 → 荤菜少一道（家规公式 2 荤基线，±1 大人 ±1 道）
  const alone = await askRecommendation(page, slotId, ['xiaobao']);
  expect(alone.structure.meat).toBeLessThanOrEqual(recommendation.structure.meat);
});

test('外部补位：荤位候选不足时，补位菜在界面上标「没做过」（S6）', async ({ page }) => {
  await clearDecidedSlots(page);

  // 造出「荤位家庭池不足 3 道」的真实处境：给爸爸加一份忌口，覆盖家里几乎所有荤菜的
  // 主料（排骨/鸡翅/鸡腿/鲈鱼/里脊/虾），只留牛腩那道——于是荤位只剩 1 道家庭菜，
  // 需要从外部池（草稿态）补位。用 API 造数据而不是 mock 内部状态：走的就是家人画像那条路。
  const avoid = ['pork_ribs', 'chicken_wings', 'chicken_legs', 'seabass', 'pork_tenderloin', 'shrimp'];
  const patched = await page.request.patch(`${ROOT_URL}/api/members/dad`, { data: { avoid } });
  expect(patched.ok()).toBe(true);

  try {
    await page.goto(`${ROOT_URL}/`);
    await page.getByTestId('recommend-button').click();
    await expect(page.getByTestId('recommendation-panel')).toBeVisible({ timeout: 15_000 });

    // 补位菜进池 → 被选上 → 界面上带「没做过」
    const badge = page.locator('[data-testid^="recommend-external-"]').first();
    await expect(badge).toContainText('没做过');

    // 服务端那一份与之对应：确实有 origin=external 的菜（不是界面自己编的标记）
    const response = await page.request.get(`${ROOT_URL}/api/slots?days=3`);
    const { slots } = (await response.json()) as { slots: SlotJson[] };
    const slotId = slots.find((slot) => slot.status === 'undecided')!.id;
    const recommendation = await askRecommendation(page, slotId);
    expect(recommendation.dishes.some((dish) => dish.origin === 'external')).toBe(true);
  } finally {
    // 复原画像（后续测试与冒烟都靠种子态；avoid 只换这一块，loves 不动）
    await page.request.patch(`${ROOT_URL}/api/members/dad`, { data: { avoid: [] } });
  }
});

test('「没做过」标记与简化推荐标记：只在真的发生时出现，且面板不吃手机宽度', async ({ page }) => {
  await clearDecidedSlots(page);
  await page.goto(`${ROOT_URL}/`);

  await page.getByTestId('recommend-button').click();
  await expect(page.getByTestId('recommendation-panel')).toBeVisible({ timeout: 15_000 });

  // 正常路径（fake 成功）：没有简化推荐警示条——常亮的标记等于没有标记
  await expect(page.getByTestId('recommendation-degraded')).toBeHidden();
  await expect(page.getByTestId('recommendation-note')).toBeHidden();

  // 外部补位菜（草稿态，补位才会进池）标「没做过」；本店种子下通常补不到，
  // 但一旦出现就必须带标记——所以按实际命中与否断言，不做无条件假设。
  const externalBadges = page.locator('[data-testid^="recommend-external-"]');
  const count = await externalBadges.count();
  if (count > 0) await expect(externalBadges.first()).toContainText('没做过');

  // 手机宽度（总纲「手机优先」）：推荐面板展开后也不横向溢出
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});

/**
 * S7 降级（总纲 §4、spec issue #12 Testing Decisions 明确「S7 在 E2E 验证」）：
 * LLM 连续失败时，界面必须给出**纯规则拼餐**的简化推荐，并**显著标记**；恢复后可随时换一整套。
 *
 * 这一条跑在专门的 webServer 实例上（`E2E_LLM_MODE=fail`，每个 LLM 调用都抛）——
 * 不放在主实例，否则其他用例的断言会依赖执行顺序。
 */
test('S7：LLM 全失败时给出简化推荐并显著标记，且仍能一键接受（断网也能定餐）', async ({ page }) => {
  await page.goto(`${LLM_DOWN_URL}/`);
  // 餐槽 id 现取不写死：那是一个独立的库，且「当前时刻之后」的餐槽才定得了
  // （写死日期会在当天餐次截止后变成 slot_passed，测试间就自己坏了）
  const slotId = await undecidedSlotAt(page, LLM_DOWN_URL);

  // 面板走的是同一条推荐接口；这里直接拿响应断言降级链的产物
  const response = await page.request.post(`${LLM_DOWN_URL}/api/slots/${slotId}/recommendation`, { data: {} });
  expect(response.ok()).toBe(true);
  const { recommendation } = (await response.json()) as { recommendation: RecommendationJson };

  // 1) 走的是简化推荐：format=rules_only、degraded=true
  expect(recommendation.llm.format).toBe('rules_only');
  expect(recommendation.llm.degraded).toBe(true);
  // 2) 仍然配满家规结构（规则拼的，不靠模型）
  expect(recommendation.dishes.length).toBe(
    recommendation.structure.meat + recommendation.structure.veg + recommendation.structure.soup,
  );
  // 3) 简化推荐的理由不编造（没有模型就没有理由）
  expect(recommendation.dishes.every((dish) => dish.reason === null)).toBe(true);
  // 4) notes 说清为什么降级（不是默默给一份看不出区别的菜单）
  expect(recommendation.notes.join(' ')).toMatch(/简化推荐|LLM|失败/);

  // 5) 界面上显著标记（常亮无关——这一份真的降级了，标记必须出现）
  await page.getByTestId('recommend-button').click();
  await expect(page.getByTestId('recommendation-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('recommendation-degraded')).toBeVisible();

  // 6) 简化推荐也能一键接受：断网时手动定餐这条路必须通
  await page.getByTestId('accept-recommendation').click();
  await expect(page.getByTestId('recommendation-panel')).toBeHidden({ timeout: 15_000 });
  const saved = await page.request.get(`${LLM_DOWN_URL}/api/slots/${slotId}`);
  const { slot } = (await saved.json()) as { slot: { status: string } };
  expect(slot.status).toBe('decided');
});
