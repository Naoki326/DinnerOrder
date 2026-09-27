import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 验收场景 S5（反馈与冷藏，总纲 §2.5、ADR-0005）：
 *   菜单阶段单道点踩 + 快捷标签；饭后餐卡的「吃后感」入口常驻（不弹窗不推送）；
 *   **点踩后该菜 14 天内不进推荐与候选**。
 *
 * LLM 是服务端注入的确定性 fake（`server/src/e2e-server.ts`）：它按 prompt 里的候选池挑选，
 * 所以「点踩后这道菜从池子里消失」在 E2E 里是被真的验过的（不是只看响应字段）。
 *
 * **时间边界**：E2E 的 webServer 不注入假时钟，而「已经上桌的餐」只能靠时间走过去产生
 * （定餐接口拒收已过截止时刻的餐槽，这是既有语义——`slot_passed`）。所以：
 *   * 「点踩 → 推荐与候选都看不到它」与「回顾页的冷藏清单」在这里端到端验；
 *   * **「吃过的一餐出现在餐后回顾卡上」与「冷藏到期自动解除」由 `server/src/api/feedback.test.ts`
 *     用注入时钟覆盖**（同一套领域逻辑，那是能可靠摆布时间的那一层）。
 *
 * ⚠️ 反馈与冷藏是**持久**的（它直接改变推荐结果），所以每个用例收尾都要清掉：
 * 同一个 E2E 库里的其它用例（推荐/换菜）不该被这里点过的踩影响。
 *
 * ⚠️ 文件名以 `r` 开头排在 `meal.spec.ts` **之后**不是随意：`meal.spec` 断言「未定餐槽的留痕是空的」，
 * 而本用例会往窗口内的餐槽里塞满菜单与留痕（append-only，清不掉）。既有的两份 spec 已经
 * 隐含依赖了文件名顺序（meal → replace）；把本文件叫 `feedback.spec.ts`（f 开头）会让它先跑、
 * 把 meal 那条打红。
 */
interface SlotJson {
  id: string;
  date: string;
  meal: 'lunch' | 'dinner';
  status: 'undecided' | 'decided';
  menu: { dishes: { recipeId: string; name: string }[] } | null;
}

interface RecommendationJson {
  dishes: { recipeId: string; name: string }[];
}

interface CandidatesJson {
  candidates: { recipeId: string; name: string }[];
}

interface FeedbackListJson {
  feedback: { slotId: string; recipeId: string; memberId: string; verdict: string; tags: string[] }[];
  cooling: { recipeId: string; name: string; until: string }[];
  meals: { slotId: string; dishes: { recipeId: string }[] }[];
}

/** 窗口内的餐槽（与 HomeView 的 `useSlots(3)` 是同一个请求，界面看到的就是这一批） */
async function windowSlots(page: Page, days = 3): Promise<SlotJson[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { slots: SlotJson[] }).slots;
}

async function clearDecidedSlots(page: Page, days = 14): Promise<void> {
  for (const slot of await windowSlots(page, days)) {
    if (slot.status !== 'decided') continue;
    const cancelled = await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
    expect(cancelled.ok()).toBe(true);
  }
}

/** 反馈是跨用例的持久状态：清掉这个库里所有反馈，让别的场景从干净的推荐结果出发 */
async function clearFeedback(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/feedback?days=365`);
  const { feedback } = (await response.json()) as FeedbackListJson;
  for (const item of feedback) {
    await page.request.delete(`${ROOT_URL}/api/feedback`, {
      data: { slotId: item.slotId, recipeId: item.recipeId, memberId: item.memberId },
    });
  }
}

/**
 * 把窗口内的**每一餐**都定成同一份菜单（素 / 荤汤 / 素汤）。
 *
 * 为什么要填满窗口：首屏大卡是「最近的一餐」= 最早的**未定**餐槽；只定其中一餐的话，
 * 定了的那餐会退到下面的小卡上（那里没有反馈条），大卡会换成更晚的一餐。
 *
 * 菜单为何是这三道：家庭池的**汤位只有三道**（冬瓜排骨汤 / 玉米胡萝卜排骨汤 / 番茄蛋花汤），
 * 于是「点踩冬瓜排骨汤 + 把另一道汤排除掉」能把候选池干成空 → 冷藏的排除在 E2E 里
 * 可以被**确定性**地验到（而不是「恰好没被前 3 个轮上」那种弱断言）。
 */
async function bookWholeWindow(page: Page): Promise<SlotJson> {
  const slots = await windowSlots(page);
  for (const slot of slots) {
    const response = await page.request.put(`${ROOT_URL}/api/slots/${slot.id}`, {
      data: {
        diners: ['mom', 'dad', 'dabao', 'xiaobao'],
        dishes: [
          { recipeId: 'suanrongcaixin' },
          { recipeId: 'dongguapaigutang' },
          { recipeId: 'fanqiedanhuatang' },
        ],
      },
    });
    expect(response.ok()).toBe(true);
  }
  return slots[0]!;
}

async function recommend(page: Page, slotId: string): Promise<RecommendationJson> {
  const response = await page.request.post(`${ROOT_URL}/api/slots/${slotId}/recommendation`, { data: {} });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { recommendation: RecommendationJson }).recommendation;
}

async function candidatesOf(page: Page, slotId: string, body: unknown): Promise<CandidatesJson> {
  const response = await page.request.post(`${ROOT_URL}/api/slots/${slotId}/candidates`, { data: body });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { candidates: CandidatesJson }).candidates;
}

async function feedbackList(page: Page): Promise<FeedbackListJson> {
  const response = await page.request.get(`${ROOT_URL}/api/feedback`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as FeedbackListJson;
}

test.afterEach(async ({ page }) => {
  // 先复位时钟再清场：时钟拨着时，那些餐已在过去、`DELETE` 也改不了位置
  // （与 promote.spec.ts 同一顺序，两个 spec 共用同一个 E2E 库）
  if (clockShifted) {
    await resetClock(page);
    clockShifted = false;
  }
  await clearFeedback(page);
  await clearDecidedSlots(page);
});

test('菜单阶段点踩 + 快捷标签：该菜从推荐与候选消失，冷藏清单可见（S5）', async ({ page }) => {
  await clearFeedback(page);
  await clearDecidedSlots(page);
  const target = await bookWholeWindow(page);

  await page.goto(`${ROOT_URL}/`);
  const hero = page.locator(`[data-slot-id="${target.id}"]`).first();
  await expect(hero).toContainText('冬瓜排骨汤');

  // 菜单阶段的反馈条就在已定菜单卡上（单道一行）：不进二级页、不弹窗
  const bar = page.getByTestId('hero-feedback-dongguapaigutang');
  await expect(bar).toBeVisible();

  // 对照组（点踩之前）：换汤位时，同桌没占的那些汤进候选。这里传的是**草稿菜单**
  // （编辑到一半的那一份：冬瓜排骨汤已经被换掉）——服务端只认客户端带回来的草稿，
  // 所以「这道菜现在不在草稿里」这件事必须由它传达（与 replace.spec 的会话排除用例同一形状）。
  const draft = {
    replacing: 'fanqiedanhuatang',
    dishes: ['suanrongcaixin', 'fanqiedanhuatang'],
    exclude: ['yumihuluobogutang'],
  };
  const beforeDislike = await candidatesOf(page, target.id, draft);
  expect(beforeDislike.candidates.map((item) => item.recipeId)).toContain('dongguapaigutang');

  // 点踩 → 快捷标签出现（总纲 §2.5：踩了才说哪里不对）
  await expect(page.getByTestId('hero-tags-dongguapaigutang')).toBeHidden();
  await page.getByTestId('hero-dislike-dongguapaigutang').click();
  const tags = page.getByTestId('hero-tags-dongguapaigutang');
  await expect(tags).toBeVisible();
  await expect(tags).toContainText('太油');

  // 选两个标签（选中即高亮；服务端那边回来的那一份是唯一真相）
  await page.getByTestId('hero-tag-太油-dongguapaigutang').click();
  await page.getByTestId('hero-tag-量太多-dongguapaigutang').click();
  await expect(page.getByTestId('hero-tag-太油-dongguapaigutang')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('hero-tag-量太多-dongguapaigutang')).toHaveAttribute('aria-pressed', 'true');

  // 服务端那一份与界面同源：反馈归属当前身份（种子缺省身份是掌勺者妈妈），带标签
  await expect
    .poll(async () => {
      const body = await feedbackList(page);
      return body.feedback.map((item) => `${item.recipeId}:${item.verdict}:${item.tags.join('+')}`);
    })
    .toContain('dongguapaigutang:dislike:太油+量太多');

  // 点踩的硬后果之一（推荐）：整餐推荐里不再出现这道菜
  expect((await recommend(page, target.id)).dishes.map((dish) => dish.recipeId)).not.toContain(
    'dongguapaigutang',
  );

  // 点踩的硬后果之二（候选，**同一个请求的前后对照**）：被冷藏的那道从候选里消失——
  // 冷藏是入池前的硬排除，与忌口同一档，不会因为「池子不多了」而被放宽放回来。
  const afterDislike = await candidatesOf(page, target.id, draft);
  expect(afterDislike.candidates.map((item) => item.recipeId)).not.toContain('dongguapaigutang');

  // 菜单卡上说清「这道为什么暂时不推」（看不见的排除会让人以为库里没有这道菜）
  await expect(page.getByTestId('hero-cooling')).toContainText('冬瓜排骨汤');

  // 餐后回顾是常驻的一页：冷藏清单在那里看得见（入口不加弹层、不需要推送）
  await page.getByTestId('tab-bar').getByText('回顾').click();
  await expect(page).toHaveURL(new RegExp(`^${ROOT_URL}/review$`));
  await expect(page.getByTestId('review-view')).toBeVisible();
  await expect(page.getByTestId('cooling-list')).toContainText('冬瓜排骨汤');
  // 天数从家规读（`GET /api/family-rules` 的 coolOffDays），不是写死的文案：
  // 「冷藏期家规可配」这件事在用户可见面上也得站得住
  await expect(page.getByTestId('cooling-hint')).toContainText('家规 14 天');

  // 撤回（判定只有赞/踩两种，「什么都不说」用撤回表达）：冷藏解除 ——
  // 同一个请求里冬瓜排骨汤又回来了（这正是对照组与冷藏期间的差别所在）
  await page.getByTestId('tab-bar').getByText('今天').click();
  await page.getByTestId('hero-clear-dongguapaigutang').click();
  await expect.poll(async () => (await feedbackList(page)).cooling.length).toBe(0);
  const afterUndo = await candidatesOf(page, target.id, draft);
  expect(afterUndo.candidates.map((item) => item.recipeId)).toContain('dongguapaigutang');
});

test('餐后回顾的「吃后感」入口常驻在底部导航，没吃过的餐不列卡、不弹窗（S5）', async ({ page }) => {
  await clearFeedback(page);
  await clearDecidedSlots(page);
  // 把窗口填满：这样首屏是已定大卡，回顾页却依然没有「吃过的一餐」（都还没到饭点）
  await bookWholeWindow(page);

  await page.goto(`${ROOT_URL}/`);
  // 打开 app 不会自己弹回顾（总纲 §2.5：不弹窗不推送）
  await expect(page.getByTestId('review-view')).toBeHidden();
  const tab = page.getByTestId('tab-bar').getByText('回顾');
  await expect(tab).toBeVisible();

  await tab.click();
  await expect(page.getByTestId('review-view')).toBeVisible();
  // 提示里的冷藏天数来自家规接口（不是硬编码的 14）：这是「冷藏期家规可配」的可见面
  await expect(page.getByTestId('review-hint')).toContainText('家规 14 天');
  await expect(page.getByTestId('review-empty')).toBeVisible();
  await expect(page.getByTestId('review-empty')).toContainText('还没有吃过的一餐');
  // 没吃过的一餐不进回顾卡（它们只是菜单，还没上桌）
  await expect(page.locator('[data-testid^="review-meal-"]')).toHaveCount(0);
});

/**
 * 历史的每一餐（本票）：回顾页不只看最近三天——往回翻能看到更早吃过的餐，
 * **而且是同一批能打分的卡片**（打分功能本来就基于这份历史列表）。
 *
 * 造历史只能靠拨钟：定餐接口拒收已过截止的餐槽，所以先定「今天往后」的餐、
 * 再把时钟往前推几天，它们就成了已经吃过的一餐（`E2E_CLOCK_CONTROL=1` 的 seam）。
 */
async function setClock(page: Page, offsetMs: number): Promise<void> {
  const response = await page.request.put(`${ROOT_URL}/api/e2e/clock`, { data: { offsetMs } });
  expect(response.ok()).toBe(true);
}

async function resetClock(page: Page): Promise<void> {
  const response = await page.request.delete(`${ROOT_URL}/api/e2e/clock`);
  expect(response.ok()).toBe(true);
}

/**
 * 拨过钟就置位，`afterEach` 据此复位。
 *
 * 不能只靠用例里的 `try/finally`：断言失败时 `finally` 虽然也会跑，但**声明在用例体里**的
 * 清理在超时/中断时不一定执行到；而时钟一旦没复位，后续用例（包括别的 spec）全在偏移的
 * “现在”下跑，失败会散到根本没碰过时钟的那些用例上。
 */
let clockShifted = false;

/** 今天之后的**两餐**（同日午/晚要拿到，好让历史里既有午餐也有晚餐） */
async function twoUpcomingSlots(page: Page): Promise<{ lunch: string; dinner: string }> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { today, slots } = (await response.json()) as { today: string; slots: SlotJson[] };
  const lunch = slots.find((slot) => slot.meal === 'lunch' && slot.date > today);
  if (!lunch) throw new Error('窗口内没有明天以后的未定午餐');
  const dinner = slots.find((slot) => slot.meal === 'dinner' && slot.date === lunch.date);
  if (!dinner) throw new Error(`${lunch.date} 的晚餐不在窗口里`);
  return { lunch: lunch.id, dinner: dinner.id };
}

async function book(page: Page, slotId: string, ...recipeIds: string[]): Promise<void> {
  const response = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: { diners: ['mom', 'dad', 'dabao', 'xiaobao'], dishes: recipeIds.map((recipeId) => ({ recipeId })) },
  });
  expect(response.ok()).toBe(true);
}

test('回顾页能往回翻出更早的餐，且翻出来的卡片照样能打分（打分基于这份历史列表）', async ({ page }) => {
  await clearFeedback(page);
  await clearDecidedSlots(page);

  const { lunch, dinner } = await twoUpcomingSlots(page);
  await book(page, lunch, 'suanrongcaixin');
  await book(page, dinner, 'qingzhengluyu');

  // 拨 6 天：这一对餐落到首屏三天窗口之外，但仍在库里
  await setClock(page, 6 * 86_400_000);
  clockShifted = true;

  await page.goto(`${ROOT_URL}/review`);
    await expect(page.getByTestId('review-view')).toBeVisible();

    // 首屏没有这几天的餐：给出实情，而不是一片空白
    await expect(page.locator('[data-testid^="review-meal-"]')).toHaveCount(0);
    await expect(page.getByTestId('review-older-only')).toContainText('更早的餐往下能翻到');

    // 「看更早的」翻出历史：两餐都在，且**由近到远**（晚餐比午餐晚，排前面）
    await page.getByTestId('review-load-earlier').click();
    const cards = page.locator('[data-testid^="review-meal-"]');
    await expect(cards).toHaveCount(2, { timeout: 15_000 });
    const ids = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-slot-id')));
    expect(ids).toEqual([dinner, lunch]);

    // 关键：历史里的卡片**照样能打分**（打分功能本来就基于这份历史列表）——
    // 卡片默认收起，先展开才看得到评论条
    const historyCard = page.getByTestId(`review-meal-${lunch}`);
    await historyCard.getByTestId(`review-toggle-${lunch}`).click();
    await historyCard.locator('[data-testid$="-like-suanrongcaixin"]').click();

    // 落库了（不是只改了个本地样式）
    await expect
      .poll(async () => {
        const list = await feedbackList(page);
        return list.feedback.some((item) => item.slotId === lunch && item.verdict === 'like');
      }, { timeout: 15_000 })
      .toBe(true);

    // 卡片上回显出刚点的赞（不是只改了个本地样式）
    await expect(historyCard.locator('[data-testid$="-liked-suanrongcaixin"]')).toBeVisible();

    // 收起回缩略态：评论条藏起来，但**菜与营养仍在**（扫历史的人多半是看“吃了什么”）
    await historyCard.getByTestId(`review-toggle-${lunch}`).click();
    await expect(historyCard.locator('[data-testid$="-like-suanrongcaixin"]')).toBeHidden();
    await expect(historyCard.getByTestId(`review-thumb-dishes-${lunch}`)).toContainText('蒜蓉菜心');
    await expect(historyCard.getByTestId(`review-nutrition-${lunch}`)).toBeVisible();
});

test('回顾卡默认收起：缩略态是「日期 + 菜名数」，菜/食谱/营养在收起时就可达', async ({ page }) => {
  await clearFeedback(page);
  await clearDecidedSlots(page);

  const { lunch } = await twoUpcomingSlots(page);
  // **5 道**：前 3 道之内与之外的食谱都要点得到（本票修的缺口：「等 N 道」把
  // 后面那几道的食谱彻底变成不可达，而展开态的菜名当时又不是入口）
  const dishes = ['suanrongcaixin', 'hongshaopaigu', 'dongguapaigutang', 'fanqiedanhuatang', 'culutudousi'];
  await book(page, lunch, ...dishes);
  await setClock(page, 6 * 86_400_000);
  clockShifted = true;

  await page.goto(`${ROOT_URL}/review`);
  await page.getByTestId('review-load-earlier').click();
  const card = page.getByTestId(`review-meal-${lunch}`);
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 默认收起：评论条不在
  await expect(card.getByTestId(`review-toggle-${lunch}`)).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByTestId(`review-toggle-${lunch}`)).toContainText('展开');
  await expect(card.locator('[data-testid$="-like-suanrongcaixin"]')).toBeHidden();

  // 缩略态**不截断**：五道菜的食谱入口全部在（没有「等 N 道」把后面几道藏起来）
  const thumb = card.getByTestId(`review-thumb-dishes-${lunch}`);
  await expect(thumb).not.toContainText('等 ');
  for (const dish of dishes) {
    await expect(card.getByTestId(`review-recipe-${lunch}-${dish}`)).toBeVisible();
  }

  // 第三道之后那道（列表里第 4 道）的食谱真的打得开
  await card.getByTestId(`review-recipe-${lunch}-fanqiedanhuatang`).click();
  await expect(page.getByTestId('recipe-sheet')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('recipe-sheet')).toContainText('番茄蛋花汤');
  // 弹层不做 Esc 关闭（Sheet 的有意取舍），所以点它自己的关闭按钮
  await page.getByTestId('recipe-sheet-close').click();
  await expect(page.getByTestId('recipe-sheet')).toBeHidden();

  // 营养（收起也看得到）
  await card.getByTestId(`review-nutrition-${lunch}`).click();
  await expect(page.getByTestId('nutrition-sheet')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('nutrition-sheet-close').click();
  await expect(page.getByTestId('nutrition-sheet')).toBeHidden();

  // 展开才看到评论——且**展开态的菜名也是食谱入口**（换了状态食谱不该“不见”）
  await card.getByTestId(`review-toggle-${lunch}`).click();
  await expect(card.locator('[data-testid$="-like-suanrongcaixin"]')).toBeVisible();
  await card.getByTestId(`review-dish-recipe-${lunch}-hongshaopaigu`).click();
  await expect(page.getByTestId('recipe-sheet')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('recipe-sheet-close').click();
  await expect(page.getByTestId('recipe-sheet')).toBeHidden();
});

test('翻到底时说的是「再往前就没有了」，而不是留一个按下去没反应的按钮', async ({ page }) => {
  await clearFeedback(page);
  await clearDecidedSlots(page);

  // 只定一餐并把它推成历史：翻一次就到头
  const { lunch } = await twoUpcomingSlots(page);
  await book(page, lunch, 'suanrongcaixin');
  await setClock(page, 6 * 86_400_000);
  clockShifted = true;

  await page.goto(`${ROOT_URL}/review`);
  await page.getByTestId('review-load-earlier').click();
  await expect(page.getByTestId(`review-meal-${lunch}`)).toBeVisible({ timeout: 15_000 });

  // 到底了：按钮换成一句实情
  await expect(page.getByTestId('review-load-earlier')).toBeHidden();
  await expect(page.getByTestId('review-history-end')).toContainText('再往前就没有了');
});
