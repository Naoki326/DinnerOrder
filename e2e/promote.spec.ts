import { expect, test, type Page } from '@playwright/test';
import { E2E, ROOT_URL } from './test-env';

/**
 * 验收场景 S6（外部补位与转正，总纲 §2.8；ADR-0006）：
 *   外部菜谱上桌 → 餐后回顾里掌勺者点「转正」→ 口述差异 → LLM 改写成家里版本 →
 *   进家庭库与推荐池 → 出现在下一次推荐里。
 *
 * ## 时间怎么被摆布（这一段是本文件能存在的前提）
 *
 * 转正的门槛是 ADR-0006 的「家里做过、家人吃过」，而「吃过」= **过了餐次截止时刻**
 * （`hasMealPassed`：家规午 14:00 / 晚 21:00）。E2E 用的是真实时钟，而餐槽定完就不能
 * 再推回过去（定餐接口拒收已过的餐）。所以本文件用 e2e-server 的**测试专用时钟控制口**
 * （`PUT /api/e2e/clock`，见 `server/src/e2e-server.ts`）把「现在」往后拨两天：
 * 那一餐自然就成了「吃过」，同时仍在餐后回顾的 3 天窗口里。
 *
 * ⚠️ 这个控制口只在 `E2E_CLOCK_CONTROL=1` 的 E2E 服务端存在（`playwright.config.ts` 只给
 * 根路径实例设了它）——生产入口（`server/src/index.ts`）没有这个开关、也没有这条路由。
 * 用法上必须成对：`beforeEach` 记下「有没有拨过」，`afterEach` 一定复位（`DELETE /api/e2e/clock`），
 * 否则同一个库里的其它 spec 会看到被拨过的时钟。
 *
 * 「开始做菜的日期一律现取」这条纪律照旧（不写死日期）：拨动是**相对**的偏移量，
 * 餐槽 id 仍然从 `/api/slots` 现读。
 *
 * ## 哪些部分留给了集成测试
 *
 *   * **LLM 改写失败 → 502、草稿原样留着**：要造一个每次调用都失败的 LLM，E2E 的 fake 是
 *     全局一个（不好在单个用例里翻脸）——由 `server/src/api/promotion.test.ts` 用注入的
 *     fake 覆盖（`setCompletionError`）；
 *   * **待重标（0 克）项在转正时真的被重标成正数**：E2E 能验「待重标项在界面上看得见」
 *     （本文件第三条用例，用 008 种下的 `pending_relabel_ribs` 自己的样张），但「重标后的克数」需要
 *     断言具体数值与「全库不再有 0 克草稿」——那些在集成测试里点得更细；
 *   * 「谁在什么时候按谁的口述改成了什么」的台账逐字段断言：集成测试里点得更细。
 *   本文件守的是**界面这条路真的通**：见过哪些 testid、拨动时钟后界面怎么变、推荐池即时生效。
 *
 * ## 收尾
 *
 * 转正是**持久**的（它改变菜谱的 status，进而改变推荐池），所以本文件只能拿一道
 * 对其它 spec 无影响的外部菜（`qingchaodouya`：素位，且换菜/推荐那两份 spec 的外部补位
 * 断言都在荤位）——而它一旦转正，后续 E2E 轮次里它一直是家庭菜谱（这正是「转正」的语义，
 * 而不是残留脏数据；同一个库每轮由 webServer 的 `rm -f data/e2e-*.db*` 重建）。
 * 后两条用例用「土豆炖排骨（待重标样本）」但**不提交转正**（只验入口可见性与「待重标」标记），
 * 所以推荐/换菜依赖的「外部池还有草稿」不受影响。
 * 末条用例（回执只挂在点过的那张卡）会真转正一道素菜草稿（`culubaicai`）——选它是因为
 * 其它 spec 的外部补位断言都在荤位、汤位那一份有自己的池干清单，碰不到这一道。
 */
const EXTERNAL = 'qingchaodouya';
/**
 * 「同一道菜出现在两张回顾卡」那条用例用的草稿（素位）。转正是**持久**的，
 * 所以选的是后面几个 spec 都不依赖的那一道（换菜的补位断言在肉位、羹汤干池断言在汤位）。
 */
const DUAL_CARD = 'culubaicai';
/**
 * 008 自己种下的「待重标样本」（主料排骨落 0 克，其余项克数齐全）。
 * 它带 0 克项 → 不进推荐/换菜候选池（迁移 005 的语义），所以拿它做入口可见性的用例
 * 不会改变外部池的组成（推荐/换菜那些 spec 依赖的「还有草稿可补位」照旧）。
 */
const PENDING_SAMPLE = 'pending_relabel_ribs';
const DINNERS = ['mom', 'dad', 'dabao', 'xiaobao'];
/** 拨两天：那一餐落进过去，同时还在餐后回顾的三天窗口里 */
const TWO_DAYS_MS = 2 * 86_400_000;
/** 再往后拨到第十二天：吃过的那一餐出了七天的去重窗口 */
const TWELVE_DAYS_MS = 12 * 86_400_000;

interface SlotJson {
  id: string;
  date: string;
  meal: 'lunch' | 'dinner';
  status: 'undecided' | 'decided';
  menu: { dishes: { recipeId: string; name: string }[] } | null;
}

interface RecipeJson {
  id: string;
  name: string;
  status: string;
  source: string;
  cuisine: string | null;
  aliases: string[];
  ingredients: { name: string; adultGrams: number }[];
}

interface RecommendationJson {
  dishes: { recipeId: string; name: string; origin: 'family' | 'external' }[];
}

interface PromotionLedgerJson {
  promotions: {
    recipeId: string;
    memberId: string | null;
    memberName: string | null;
    differences: string;
    cuisineFrom: string | null;
    cuisineTo: string | null;
    llmModel: string | null;
    llmPromptVersion: string | null;
  }[];
}

/** 拨动 E2E 服务端的注入时钟（只有根路径实例有这个控制口，见文件头） */
async function setClock(page: Page, offsetMs: number): Promise<void> {
  const response = await page.request.put(`${ROOT_URL}/api/e2e/clock`, { data: { offsetMs } });
  expect(response.ok()).toBe(true);
}

async function resetClock(page: Page): Promise<void> {
  const response = await page.request.delete(`${ROOT_URL}/api/e2e/clock`);
  expect(response.ok()).toBe(true);
}

/** 清场：窗口内已定的餐槽全取消（各用例都要一张干净的未定大卡） */
async function clearDecidedSlots(page: Page, days = 14): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
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

/**
 * 同一天里午餐与晚餐都未定的一对餐槽，**从明天起找**（今天已过截止时刻的那一餐会被
 * 定餐接口拒收，而真正的固定时间点不可控）。拨两天后这一天落在回顾窗口的昨天，
 * 两餐都「已经吃过」——于是同一道菜同时出现在两张回顾卡上。
 */
async function sameDayPairFromTomorrow(page: Page): Promise<{ lunch: string; dinner: string }> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { today, slots } = (await response.json()) as { today: string; slots: SlotJson[] };
  const lunch = slots.find((item) => item.meal === 'lunch' && item.date > today && item.status === 'undecided');
  if (!lunch) throw new Error('窗口内没有明天以后的未定午餐');
  const dinner = slots.find(
    (item) => item.meal === 'dinner' && item.date === lunch.date && item.status === 'undecided',
  );
  if (!dinner) throw new Error(`${lunch.date} 的晚餐不是未定的`);
  return { lunch: lunch.id, dinner: dinner.id };
}

/** 备一餐：只有那一道外部菜（转正门槛只要求「这道菜上过桌」） */
async function bookExternal(page: Page, slotId: string, recipeId = EXTERNAL): Promise<void> {
  const response = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: { diners: DINNERS, dishes: [{ recipeId }] },
  });
  expect(response.ok()).toBe(true);
}

async function getRecipe(page: Page, id: string): Promise<RecipeJson> {
  const response = await page.request.get(`${ROOT_URL}/api/recipes/${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { recipe: RecipeJson }).recipe;
}

let clockShifted = false;

test.afterEach(async ({ page }) => {
  // 先复位时钟再清场：复位之后刚定的那一餐才回到「未来」，才能出现在 /slots 的窗口里被取消
  if (clockShifted) {
    await resetClock(page);
    clockShifted = false;
  }
  await clearDecidedSlots(page);
});

test('外部菜上桌 → 回顾里转正 → 进家庭库与下次推荐（S6）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  await bookExternal(page, slotId);

  // 拨两天：那一餐成了「已经吃过」，午餐/晚餐都过了截止时刻
  await setClock(page, TWO_DAYS_MS);
  clockShifted = true;

  // 餐后回顾里看得见这一餐（门槛与回顾同源：最后一条非取消事件 + 过了截止时刻）
  await page.goto(`${ROOT_URL}/review`);
  const card = page.getByTestId(`review-meal-${slotId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('清炒豆芽');

  // 掌勺者（种子缺省身份=妈妈，is_cook=1）看得到「转正」入口；展开它
  const form = card.getByTestId(`promote-${EXTERNAL}`);
  await expect(form).toBeVisible();
  await form.getByTestId(`promote-open-${EXTERNAL}`).click();

  // 口述差异 + 校对菜系（总纲 §2.8：转正时掌勺者校对 tag）
  await expect(form.getByTestId(`promote-cuisine-${EXTERNAL}`)).toHaveValue('家常');
  await form.getByTestId(`promote-differences-${EXTERNAL}`).fill('不放蒜');
  await form.getByTestId(`promote-cuisine-${EXTERNAL}`).selectOption('粤');

  await form.getByTestId(`promote-submit-${EXTERNAL}`).click();

  // 界面上给出回执（不是一闪就完事），表单本身随「不再是草稿」一起消失
  await expect(card.getByTestId(`promoted-${EXTERNAL}`)).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId(`promoted-${EXTERNAL}`)).toContainText('已转正');
  await expect(card.getByTestId(`promote-${EXTERNAL}`)).toBeHidden();

  // 服务端那一份与界面同源：状态翻转、差异落在食材清单上、菜系用掌勺者校对的值
  const recipe = await getRecipe(page, EXTERNAL);
  expect(recipe.status).toBe('active');
  // 身份不变：转正改的是做法，不是「这道菜从哪来」
  expect(recipe.name).toBe('清炒豆芽');
  expect(recipe.source).toBe('howtocook');
  // 「不放蒜」→ 蒜不在清单里了（出参里的 0 = 确认不放，转正落库时该项被丢掉）；豆芽还在
  expect(recipe.ingredients.map((item) => item.name)).toEqual(['豆芽']);
  expect(recipe.ingredients.every((item) => item.adultGrams > 0)).toBe(true);
  expect(recipe.cuisine).toBe('粤');

  // 台账（总纲 §2.8「编辑留痕」）：谁按谁的口述改的、菜系前后值、哪个模型改的
  const ledgerResponse = await page.request.get(`${ROOT_URL}/api/recipes/${EXTERNAL}/promotions`);
  expect(ledgerResponse.ok()).toBe(true);
  const ledger = ((await ledgerResponse.json()) as PromotionLedgerJson).promotions;
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({
    recipeId: EXTERNAL,
    memberId: 'mom',
    memberName: '妈妈',
    differences: '不放蒜',
    cuisineFrom: '家常',
    cuisineTo: '粤',
    llmModel: E2E.fakeModel,
    llmPromptVersion: '2026-09-promotion-v1',
  });

  // ---------------------------------------------------------------- 即时进推荐池
  // 再拨到第十二天：吃过的那一餐出了七天去重窗口，否则它自己会被「最近吃过」挡住
  await setClock(page, TWELVE_DAYS_MS);

  // 把爸爸的忌口换成「除了这道菜之外的素菜主料」，让素位只剩这一道——
  // 推荐是现算的（不落库），用真实的家人口味造出「确定性会选它」的处境（与 recommend.spec 同一手法）。
  // 注意不含 bean_sprouts（那会把主角自己也排掉）；蒜已在转正时去掉，所以可以直接禁掉。
  const avoid = [
    'tomato', 'egg', 'choy_sum', 'garlic', 'potato', 'vinegar', 'baby_cabbage', 'pork_mince',
    'tofu', 'doubanjiang', 'rice', 'scallion', 'lettuce', 'oyster_sauce', 'chinese_cabbage', 'cucumber',
  ];
  const patched = await page.request.patch(`${ROOT_URL}/api/members/dad`, { data: { avoid } });
  expect(patched.ok()).toBe(true);

  try {
    await page.goto(`${ROOT_URL}/`);
    await page.getByTestId('recommend-button').click();
    const panel = page.getByTestId('recommendation-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // 它进了这份推荐，而且不再是「没做过」（外部补位菜才有那个标记）——S6 的验收句
    await expect(page.getByTestId(`recommend-dish-${EXTERNAL}`)).toBeVisible();
    await expect(page.getByTestId(`recommend-external-${EXTERNAL}`)).toBeHidden();

    // 服务端那一份与界面同源：origin='family'（家庭池的唯一来源是转正态）
    const hero = page.getByTestId('empty-slot');
    const recommendedSlot = (await hero.getAttribute('data-slot-id'))!;
    const recommendationResponse = await page.request.post(
      `${ROOT_URL}/api/slots/${recommendedSlot}/recommendation`,
      { data: {} },
    );
    expect(recommendationResponse.ok()).toBe(true);
    const { recommendation } = (await recommendationResponse.json()) as { recommendation: RecommendationJson };
    const picked = recommendation.dishes.find((dish) => dish.recipeId === EXTERNAL);
    expect(picked).toBeDefined();
    expect(picked!.origin).toBe('family');

    // 外部池里少了一道：草稿列表里没有它了（状态机迁移的可见面）
    const draftsResponse = await page.request.get(`${ROOT_URL}/api/recipes?status=draft`);
    const { recipes: drafts } = (await draftsResponse.json()) as { recipes: RecipeJson[] };
    expect(drafts.map((item) => item.id)).not.toContain(EXTERNAL);
  } finally {
    // 复原画像：后续 spec 与冒烟都靠种子态
    await page.request.patch(`${ROOT_URL}/api/members/dad`, { data: { avoid: [] } });
  }
});

test('转过正的菜再点转正是 409、上过桌的才能转：门槛在真实进程里成立（ADR-0006）', async ({ page }) => {
  await clearDecidedSlots(page);

  // ① 已转正的家庭菜谱（种子里的）不能转正——状态机只允许 draft → active 一次
  const active = await page.request.post(`${ROOT_URL}/api/recipes/suanrongcaixin/promotion`, { data: {} });
  expect(active.status()).toBe(409);
  expect(((await active.json()) as { error: string }).error).toBe('not_draft');

  // ② 从没上过桌的草稿不能转正（「家里做过、家人吃过」是门槛，不是「谁点了一下」）
  const slotId = await nextUndecidedSlot(page);
  await bookExternal(page, slotId, 'culubaicai');
  const never = await page.request.post(`${ROOT_URL}/api/recipes/culubaicai/promotion`, { data: {} });
  expect(never.status()).toBe(400);
  expect(((await never.json()) as { error: string }).error).toBe('recipe_not_served');
  // 失败没有半截：还是草稿、没有台账
  expect((await getRecipe(page, 'culubaicai')).status).toBe('draft');
  const ledger = await page.request.get(`${ROOT_URL}/api/recipes/culubaicai/promotions`);
  expect(((await ledger.json()) as PromotionLedgerJson).promotions).toHaveLength(0);
});

test('转正入口只给掌勺者、「待重标」项看得见（#19 台账点名交给 #21）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  // 用 008 自己种下的「土豆炖排骨（待重标样本）」：排骨落 0 克待重标（模糊份量等 LLM 重标），
  // 是种子里唯一带待重标项的草稿。这条用例不提交转正（只验入口的可见性），
  // 所以它前后都是草稿——推荐/换菜那些 spec 依赖的「外部池还有草稿」不受影响。
  await bookExternal(page, slotId, PENDING_SAMPLE);
  await setClock(page, TWO_DAYS_MS);
  clockShifted = true;

  await page.goto(`${ROOT_URL}/review`);
  const card = page.getByTestId(`review-meal-${slotId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 掌勺者展开表单：待重标项要看得见——那是导入菜与家里确认过的菜最实质的差别之一
  // （转正会把克数固化成家庭基准，所以这一步先把未定的项摆到掌勺者眼前）
  await card.getByTestId(`promote-open-${PENDING_SAMPLE}`).click();
  const pending = card.getByTestId(`promote-pending-${PENDING_SAMPLE}`);
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('排骨');
  await expect(card.getByTestId(`promote-differences-${PENDING_SAMPLE}`)).toBeVisible();

  // 切成大宝（不是掌勺者）：转正表单消失，换成一句说明
  await page.getByTestId('identity-chip').click();
  await page.getByTestId('identity-option-dabao').click();
  await expect(page.getByTestId('identity-name')).toHaveText('大宝');

  await expect(card.getByTestId(`promote-cook-only-${PENDING_SAMPLE}`)).toBeVisible();
  await expect(card.getByTestId(`promote-${PENDING_SAMPLE}`)).toBeHidden();
  await expect(card.getByTestId(`promote-open-${PENDING_SAMPLE}`)).toBeHidden();
});

/**
 * 同一道菜同时出现在两张回顾卡上时，回执只挂在**点过的那一张**。
 *
 * 背景（评审点出）：回执原本以 `recipeId` 为键，两张卡会同时显示「已转正」——而掌勺者只点过一次。
 * 键改成 `${slotId}:${recipeId}` 后，未点过的那张回到无表单、无回执的状态（菜谱已是家庭菜，
 * 转正入口本来就不该再出现）。
 */
test('同一道菜在两张回顾卡上：回执只挂在点过的那张（回执的键是卡 + 菜，不是光一个菜谱 id）', async ({ page }) => {
  await clearDecidedSlots(page);
  const { lunch, dinner } = await sameDayPairFromTomorrow(page);
  await bookExternal(page, lunch, DUAL_CARD);
  await bookExternal(page, dinner, DUAL_CARD);
  await setClock(page, TWO_DAYS_MS);
  clockShifted = true;

  await page.goto(`${ROOT_URL}/review`);
  const lunchCard = page.getByTestId(`review-meal-${lunch}`);
  const dinnerCard = page.getByTestId(`review-meal-${dinner}`);
  await expect(lunchCard).toBeVisible({ timeout: 15_000 });
  await expect(dinnerCard).toBeVisible({ timeout: 15_000 });

  // 两张卡上都有转正入口：同一道菜同时出现在两张卡（同一个 `review-dish-*` testid 靠外层卡区分）
  await lunchCard.getByTestId(`promote-open-${DUAL_CARD}`).click();
  await expect(lunchCard.getByTestId(`promote-differences-${DUAL_CARD}`)).toBeVisible();
  await expect(dinnerCard.getByTestId(`promote-open-${DUAL_CARD}`)).toBeVisible();

  await lunchCard.getByTestId(`promote-submit-${DUAL_CARD}`).click();
  await expect(lunchCard.getByTestId(`promoted-${DUAL_CARD}`)).toBeVisible({ timeout: 15_000 });

  // 关键断言：晚餐那张卡**没有**回执（掌勺者只点过一次）
  await expect(dinnerCard.getByTestId(`promoted-${DUAL_CARD}`)).toBeHidden();
  // 它也不再显示转正入口：这道菜已经进了家庭库（表单的消失由状态驱动，回执不负责这个）
  await expect(dinnerCard.getByTestId(`promote-${DUAL_CARD}`)).toBeHidden();
});

test('回顾页的转正表单不吃手机宽度（总纲「手机优先」）', async ({ page }) => {
  await clearDecidedSlots(page);
  const slotId = await nextUndecidedSlot(page);
  await bookExternal(page, slotId, PENDING_SAMPLE);
  await setClock(page, TWO_DAYS_MS);
  clockShifted = true;

  await page.goto(`${ROOT_URL}/review`);
  const card = page.getByTestId(`review-meal-${slotId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByTestId(`promote-open-${PENDING_SAMPLE}`).click();
  await expect(card.getByTestId(`promote-differences-${PENDING_SAMPLE}`)).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(E2E.viewport.width);
});
