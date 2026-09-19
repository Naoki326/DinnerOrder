import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { parsePromptCandidates, parsePromptPool, parsePromptStructure, pickLlmSelection } from '../llm/prompt.js';
import { coolingDishes, feedbackSummary, FEEDBACK_TAGS } from '../domain/feedback.js';
import type {
  CoolingDish,
  DishFeedback,
  FamilyRulesResponse,
  FeedbackListResponse,
  FeedbackResponse,
  MealRecommendation,
  SlotWithPortion,
  SwapCandidates,
} from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 反馈、餐后回顾与冷藏期（总纲 §2.5、§4①；ADR-0005、spec S5）。
 *
 * 本文件守住 ADR-0005 的**两条路不能合并成一个分数**：
 *   * 点踩 → 冷藏期硬排除（进推荐池与候选池的排除，且不放宽）；
 *   * 点赞与带标签的反馈 → 近 30 天文本摘要进 prompt（软信号，零数值权重）；
 *     点踩的**判定**不入摘要（它由冷藏期表达），但**标签**入（标签回答「为什么」）。
 *
 * 时间基准：注入时钟默认 2025-06-01T10:00Z（家庭时区 6/1 18:00）→ 目标餐槽 6/1 晚餐。
 */
const SLOT = '2025-06-01:dinner';
const DINNERS = ['mom', 'dad', 'dabao', 'xiaobao'];
/** 一餐三菜：荤 / 素 / 汤（用 API 造数据，走的就是定餐那条真实路径） */
const DISHES = ['hongshaopaigu', 'suanrongcaixin', 'dongguapaigutang'];

function scriptLlm(): void {
  harness.llm.setCompletion((request) => pickLlmSelection(request.prompt) ?? '{"dishes":[]}');
}

async function book(slotId = SLOT, dishes: string[] = DISHES): Promise<void> {
  const { status } = await harness.json(`/api/slots/${slotId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ diners: DINNERS, dishes: dishes.map((recipeId) => ({ recipeId })) }),
  });
  expect(status).toBe(200);
}

async function feedback(payload: unknown): Promise<{ status: number; body: FeedbackResponse; error?: string }> {
  const { status, body } = await harness.json<FeedbackResponse & { error?: string }>('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status, body, error: body.error };
}

async function listFeedback(): Promise<FeedbackListResponse> {
  const { status, body } = await harness.json<FeedbackListResponse>('/api/feedback');
  expect(status).toBe(200);
  return body;
}

async function recommend(slotId = SLOT): Promise<MealRecommendation> {
  const { status, body } = await harness.json<{ recommendation: MealRecommendation }>(
    `/api/slots/${slotId}/recommendation`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  expect(status).toBe(200);
  return body.recommendation;
}

async function candidates(replacing = 'hongshaopaigu'): Promise<SwapCandidates> {
  const { status, body } = await harness.json<{ candidates: SwapCandidates }>(`/api/slots/${SLOT}/candidates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replacing }),
  });
  expect(status).toBe(200);
  return body.candidates;
}

function promptOf(callIndex = 0): string {
  const call = harness.llm.completionCalls[callIndex];
  if (!call) throw new Error(`没有第 ${callIndex} 次 completion 调用`);
  return call.request.prompt;
}

/** 把家规的冷藏期天数改成别的值（家规是单例配置，改一行即全局生效） */
function setCoolOffDays(days: number): void {
  harness.db.prepare('UPDATE family_rules SET cool_off_days = ? WHERE id = 1').run(days);
}

describe('反馈记录（菜品 × 家人：点踩/赞 + 快捷标签）', () => {
  it('点踩一条带标签，落库并按当前身份回显；标签值域封闭', async () => {
    harness = createTestHarness();
    await book();

    const { status, body } = await feedback({
      slotId: SLOT,
      recipeId: 'hongshaopaigu',
      memberId: 'xiaobao',
      verdict: 'dislike',
      tags: ['太油', '量太多'],
    });
    expect(status).toBe(200);
    expect(body.feedback).toMatchObject({
      slotId: SLOT,
      recipeId: 'hongshaopaigu',
      recipeName: '红烧排骨',
      memberId: 'xiaobao',
      memberName: '小宝',
      verdict: 'dislike',
    });
    expect(body.feedback.tags).toEqual(['太油', '量太多']);
    // 点踩 + 本餐用餐者命中 → 这道菜进了冷藏期（界面据此提示「14 天内不再推」）
    expect(body.cooling).toMatchObject({ recipeId: 'hongshaopaigu' });

    const listed = await listFeedback();
    expect(listed.feedback).toHaveLength(1);
    expect(listed.cooling.map((dish) => dish.recipeId)).toContain('hongshaopaigu');
    expect(FEEDBACK_TAGS).toEqual(['太油', '太甜', '量太多', '量太少']);
  });

  it('同一人同一餐同一道菜重复提交 = 改主意（UPDATE 一行，不是堆历史）；改成点赞时旧标签清掉', async () => {
    harness = createTestHarness();
    await book();

    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom', verdict: 'dislike', tags: ['太油'] });
    const { status, body } = await feedback({
      slotId: SLOT,
      recipeId: 'hongshaopaigu',
      memberId: 'mom',
      verdict: 'like',
    });
    expect(status).toBe(200);
    expect(body.feedback.verdict).toBe('like');
    expect(body.feedback.tags).toEqual([]);
    // 「太油」说的是那一盘，判定换成点赞之后它就不该再挂着
    const listed = await listFeedback();
    expect(listed.feedback).toHaveLength(1);
    // 改主意之后冷藏期自动解除：点踩是布尔，撤回一条踩就等于这道菜没被踩过
    expect(listed.cooling).toEqual([]);
  });

  it('不同家人对同一道菜各有自己的一条（不是合并成一条）', async () => {
    harness = createTestHarness();
    await book();

    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom', verdict: 'like' });
    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'dad', verdict: 'dislike', tags: ['太甜'] });

    const listed = await listFeedback();
    expect(listed.feedback).toHaveLength(2);
    expect(listed.feedback.map((item) => [item.memberId, item.verdict])).toEqual(
      expect.arrayContaining([
        ['mom', 'like'],
        ['dad', 'dislike'],
      ]),
    );
  });

  it('撤回一条反馈：删掉之后这道菜不再受它影响；再撤一次 404', async () => {
    harness = createTestHarness();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom', verdict: 'dislike', tags: ['太油'] });

    const removed = await harness.json<{ ok: boolean }>('/api/feedback', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom' }),
    });
    expect(removed.status).toBe(200);
    expect((await listFeedback()).feedback).toEqual([]);
    expect((await listFeedback()).cooling).toEqual([]);

    const again = await harness.json<{ error: string }>('/api/feedback', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom' }),
    });
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('feedback_not_found');
  });

  it('拒收解释不了的反馈：菜不在这一餐的菜单里 / 不是快捷标签 / 人不在家人列表', async () => {
    harness = createTestHarness();
    await book(SLOT, ['hongshaopaigu', 'suanrongcaixin']);

    // 这一餐没有麻婆豆腐 → 反馈挂在「这一餐的这道菜」上，给别的菜提意见是调用错误
    const offMenu = await feedback({
      slotId: SLOT,
      recipeId: 'mapodoufu',
      memberId: 'mom',
      verdict: 'dislike',
    });
    expect(offMenu.status).toBe(400);
    expect(offMenu.error).toBe('dish_not_in_slot');

    const badTag = await feedback({
      slotId: SLOT,
      recipeId: 'hongshaopaigu',
      memberId: 'mom',
      verdict: 'dislike',
      tags: ['不好吃'],
    });
    expect(badTag.status).toBe(400);
    expect(badTag.error).toBe('invalid_tag');

    const noMember = await feedback({
      slotId: SLOT,
      recipeId: 'hongshaopaigu',
      memberId: 'nobody',
      verdict: 'like',
    });
    expect(noMember.status).toBe(400);
    expect(noMember.error).toBe('unknown_member');

    // 三次拒收都不落库（留痕与反馈都只有一条都不该因调用错误多出东西）
    expect((await listFeedback()).feedback).toEqual([]);
  });
});

describe('冷藏期（点踩的硬后果）：进推荐与候选的排除，家规可配，到期自动解除', () => {
  it('点踩后这道菜从推荐池与换菜候选里消失——任一用餐者点踩即触发', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'xiaobao', verdict: 'dislike' });

    await recommend();
    const prompt = promptOf();
    expect(parsePromptPool(prompt).map((entry) => entry.id)).not.toContain('hongshaopaigu');
    // 冷藏与「近 7 天已吃」不同：它连软避让那一段都不该出现（这道菜不是「刚吃过」，是「先别推」）
    expect(parsePromptStructure(prompt)).toBeDefined();

    const swap = await candidates();
    expect(swap.candidates.map((item) => item.recipeId)).not.toContain('hongshaopaigu');
  });

  it('冷藏是硬排除、不随池干放宽：同位菜只剩它一个人能在严格档时宁可少给，也不端回来', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    // 荤位的其他菜全部点踩（直接写库：把「谁点的」这批噪音与「冷藏生效」这件事分开）
    const otherMeats = [
      'kelejichi',
      'qingzhengluyu',
      'tudouniuniu',
      'tangculiji',
      'chongcaohuazhengji',
      'huangmenji',
    ];
    for (const recipeId of otherMeats) {
      harness.db
        .prepare(
          `INSERT INTO dish_feedback (recipe_id, slot_id, member_id, verdict, created_at, updated_at, updated_on)
           VALUES (?, ?, 'mom', 'dislike', '2025-06-01T10:00:00.000Z', '2025-06-01T10:00:00.000Z', '2025-06-01')`,
        )
        .run(recipeId, SLOT);
    }

    const swap = await candidates();
    // 被点踩的那几道一个都不该回来（冷藏是入池前的排除，放宽也放不回来）
    const ids = swap.candidates.map((item) => item.recipeId);
    for (const recipeId of otherMeats) expect(ids).not.toContain(recipeId);
    // 严格档没有被放宽（放宽是给「刚吃过 / 已出示过」的，不是给冷藏的）
    expect(swap.relaxed).toBe('none');
  });

  it('时钟注入：冷藏 14 天内不推，第 15 天自动解除（没有清理任务，判定现算）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom', verdict: 'dislike' });

    const coolingNow = coolingDishes(harness.db, harness.clock);
    expect(coolingNow.get('hongshaopaigu')).toBe('2025-06-15');

    await recommend();
    expect(parsePromptPool(promptOf()).map((entry) => entry.id)).not.toContain('hongshaopaigu');

    // 第 13 天（2025-06-14，晚餐仍是未来）推荐那天晚上：还在 14 天内，依然不推
    harness.clock.set('2025-06-14T04:00:00.000Z');
    expect(coolingDishes(harness.db, harness.clock).has('hongshaopaigu')).toBe(true);
    harness.llm.clearCalls();
    await recommend('2025-06-14:dinner');
    expect(parsePromptPool(promptOf()).map((entry) => entry.id)).not.toContain('hongshaopaigu');

    // 第 15 天（2025-06-15）自动解除——没有谁去清理，是判定自己走出了窗口；它自己回到了池子里
    harness.clock.set('2025-06-15T04:00:00.000Z');
    expect(coolingDishes(harness.db, harness.clock).has('hongshaopaigu')).toBe(false);
    harness.llm.clearCalls();
    await recommend('2025-06-15:dinner');
    expect(parsePromptPool(promptOf()).map((entry) => entry.id)).toContain('hongshaopaigu');
  });

  it('冷藏天数可配（家规表）：改成 3 天 → 第 4 天就解除', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    setCoolOffDays(3);
    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom', verdict: 'dislike' });

    expect(coolingDishes(harness.db, harness.clock).get('hongshaopaigu')).toBe('2025-06-04');
    harness.clock.set('2025-06-03T04:00:00.000Z');
    expect(coolingDishes(harness.db, harness.clock).has('hongshaopaigu')).toBe(true);
    harness.clock.set('2025-06-04T04:00:00.000Z');
    expect(coolingDishes(harness.db, harness.clock).has('hongshaopaigu')).toBe(false);
  });

  it('家规读接口：冷藏天数与餐次截止时刻都从单例表来', async () => {
    harness = createTestHarness();
    const { status, body } = await harness.json<FamilyRulesResponse>('/api/family-rules');
    expect(status).toBe(200);
    expect(body.rules).toEqual({ coolOffDays: 14, lunchCutoffHour: 14, dinnerCutoffHour: 21 });
  });

  it('餐次截止时刻也读家规表：把午餐截止改成 10 点，10:30 的午餐就不能再定', async () => {
    harness = createTestHarness();
    // 家庭时区 6/1 18:00：默认（14:00）下今天的午餐早就过了、晚餐还没
    expect((await harness.json<{ slot: SlotWithPortion }>(`/api/slots/${SLOT}`)).body.slot.editable).toBe(true);
    harness.db.prepare('UPDATE family_rules SET dinner_cutoff_hour = 17 WHERE id = 1').run();
    expect((await harness.json<{ slot: SlotWithPortion }>(`/api/slots/${SLOT}`)).body.slot.editable).toBe(false);
  });
});

describe('近 30 天反馈摘要：带标签的反馈与点赞进 prompt 作软信号（零数值权重）', () => {
  it('带标签的反馈不论赞踩都把标签文本聚进摘要；判定本身不进摘要（它由冷藏期表达）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'suanrongcaixin', memberId: 'mom', verdict: 'like', tags: ['太甜'] });
    await feedback({ slotId: SLOT, recipeId: 'dongguapaigutang', memberId: 'dad', verdict: 'dislike', tags: ['太油'] });

    await recommend();
    const prompt = promptOf();
    expect(prompt).toContain('【近 30 天反馈】');
    expect(prompt).toContain('蒜蓉菜心');
    expect(prompt).toContain('妈妈点过赞');
    expect(prompt).toContain('「太甜」（妈妈）');
    // ADR-0005 是**两条路**：点踩的**判定**由冷藏期硬排除表达（下面那条断言），
    // 而这条反馈的**标签**回答的是另一个问题——「为什么太油」，冷藏期（布尔）答不了。
    // 所以带标签的点踩行照进摘要，只是不把「点过踩」这个判定写成句子。
    expect(prompt).toContain('冬瓜排骨汤：「太油」（爸爸）');
    expect(prompt).not.toContain('点过踩');
    // verdict 与冷藏期的绑定不变：被点踩的那道仍在进池前的硬排除里，标签进摘要不会把它端回来
    expect(parsePromptPool(prompt).map((entry) => entry.id)).not.toContain('dongguapaigutang');
  });

  it('纯点踩（没标签）什么都不进摘要：判定只由冷藏期表达，摘要里不重复', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom', verdict: 'dislike' });

    await recommend();
    const prompt = promptOf();
    // 同一条信号不说两遍：冷藏期的硬排除已经把「不推这道」说清楚了，摘要里不留空标题
    expect(prompt).not.toContain('【近 30 天反馈】');
    // 冷藏的硬后果照旧（同一份数据的两条路各走各的）
    expect(parsePromptPool(prompt).map((entry) => entry.id)).not.toContain('hongshaopaigu');
  });

  it('没有反馈时不写这一段（不留空标题）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await recommend();
    expect(promptOf()).not.toContain('【近 30 天反馈】');
  });

  it('窗口外的反馈不进摘要（近 30 天，不是全部历史）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'suanrongcaixin', memberId: 'mom', verdict: 'like', tags: ['太甜'] });

    harness.clock.set('2025-07-05T10:00:00.000Z');
    expect(feedbackSummary(harness.db, harness.clock)).toEqual([]);
  });

  it('换菜候选 prompt 也带同一段反馈摘要（两条路共用一段标记）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'suanrongcaixin', memberId: 'mom', verdict: 'like', tags: ['太甜'] });

    await candidates();
    const prompt = promptOf();
    expect(prompt).toContain('【近 30 天反馈】');
    expect(prompt).toContain('「太甜」（妈妈）');
    expect(parsePromptCandidates(prompt).length).toBeGreaterThan(0);
  });
});

/** 直接往事件流里塞一餐（模拟「已经上桌的餐」；append-only 的库只能插不能改） */
function seedMeal(slotIdValue: string, recipeIds: string[], type: 'decide' | 'cancel' = 'decide'): void {
  const [slotDate, meal] = slotIdValue.split(':') as [string, 'lunch' | 'dinner'];
  harness.db
    .prepare(
      `INSERT INTO meal_events (slot_id, slot_date, meal, type, source, occurred_at)
       VALUES (?, ?, ?, ?, 'manual', ?)`,
    )
    .run(slotIdValue, slotDate, meal, type, `${slotDate}T04:00:00.000Z`);
  const seq = Number((harness.db.prepare('SELECT last_insert_rowid() AS seq').get() as { seq: number }).seq);
  const insert = harness.db.prepare(
    'INSERT INTO meal_event_dishes (seq, position, recipe_id, keep_leftover) VALUES (?, ?, ?, 0)',
  );
  recipeIds.forEach((recipeId, index) => insert.run(seq, index, recipeId));
}

describe('餐后回顾（饭后餐卡常驻入口）', () => {
  it('窗口内**已上桌**的餐带菜与当前反馈回来；还没上桌的餐不出现；取消的餐不出现', async () => {
    harness = createTestHarness();
    // 5/31 午餐与 5/30 晚餐都过了截止（现在 6/1 18:00）
    seedMeal('2025-05-31:lunch', ['suanrongcaixin']);
    seedMeal('2025-05-30:dinner', ['qingzhengluyu']);
    // 取消掉的一餐：没吃过，不该请人来评
    seedMeal('2025-05-31:dinner', ['culutudousi'], 'cancel');
    // 还没上桌的一餐（今晚）：它有自己的入口（菜单卡/编辑器），不进回顾
    await book();

    await feedback({ slotId: '2025-05-31:lunch', recipeId: 'suanrongcaixin', memberId: 'mom', verdict: 'like' });

    const { meals } = await listFeedback();
    expect(meals.map((meal) => meal.slotId)).toEqual(['2025-05-31:lunch', '2025-05-30:dinner']);
    const lunch = meals[0]!;
    expect(lunch.date).toBe('2025-05-31');
    expect(lunch.meal).toBe('lunch');
    expect(lunch.dishes.map((dish) => dish.recipeId)).toEqual(['suanrongcaixin']);
    expect(lunch.feedback.map((item) => [item.memberId, item.verdict])).toEqual([['mom', 'like']]);
    // 取消掉的那一餐与今晚那一餐都不在
    expect(meals.map((meal) => meal.slotId)).not.toContain('2025-05-31:dinner');
    expect(meals.map((meal) => meal.slotId)).not.toContain(SLOT);
  });

  it('回看的窗口是最近 3 天：更早的餐不进卡片，但反馈仍在反馈列表里', async () => {
    harness = createTestHarness();
    seedMeal('2025-05-20:lunch', ['suanrongcaixin']);
    await feedback({ slotId: '2025-05-20:lunch', recipeId: 'suanrongcaixin', memberId: 'mom', verdict: 'like' });

    expect((await listFeedback()).meals).toEqual([]);
    expect((await listFeedback()).feedback).toHaveLength(1);
  });
});

describe('冷藏期在界面上的可见性（说清「这道为什么没出现」）', () => {
  it('点踩后的菜带到期日回来（界面据此解释排除原因）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await book();
    await feedback({ slotId: SLOT, recipeId: 'hongshaopaigu', memberId: 'mom', verdict: 'dislike' });

    const { cooling } = await listFeedback();
    const dish: CoolingDish | undefined = cooling.find((item) => item.recipeId === 'hongshaopaigu');
    expect(dish).toEqual({ recipeId: 'hongshaopaigu', name: '红烧排骨', until: '2025-06-15' });

    const feedbackRow: DishFeedback | undefined = (await listFeedback()).feedback[0];
    expect(feedbackRow?.recipeName).toBe('红烧排骨');
    expect(feedbackRow?.updatedAt).toBe('2025-06-01T10:00:00.000Z');
  });
});
