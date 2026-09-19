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
