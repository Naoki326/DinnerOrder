import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, seedAvoider, type TestHarness } from '../testing/harness.js';
import { parsePromptCandidates, parsePromptSwap, pickLlmSelection } from '../llm/prompt.js';
import type { MealEvent, SlotResponse, SwapCandidates, SlotWithPortion } from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 换菜与候选（总纲 §2.3、§4；spec S2）。
 *
 * 时间基准：注入时钟默认 2025-06-01T10:00Z（家庭时区 6/1 18:00）→ 目标餐槽 6/1 晚餐，6 月。
 * 家庭荤菜 8 道（红烧排骨/可乐鸡翅/清蒸鲈鱼/土豆炖牛腩/糖醋里脊/虫草花蒸鸡/白灼虾/黄焖鸡），
 * 外部草稿荤菜 3 道（宫保鸡丁/回锅肉/番茄牛腩）。
 */
const SLOT = '2025-06-01:dinner';

interface CandidatesError {
  error?: string;
  recipeId?: string;
  memberId?: string;
  id?: string;
}

/** 让 fake 像真模型那样「从池中选」：确定性、两条路（整餐 / 换菜）都覆盖 */
function scriptLlm(): void {
  harness.llm.setCompletion((request) => pickLlmSelection(request.prompt) ?? '{"dishes":[]}');
}

async function book(payload: unknown, slotId = SLOT): Promise<void> {
  const { status } = await harness.json(`/api/slots/${slotId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(status).toBe(200);
}

async function candidates(
  payload: unknown,
  slotId = SLOT,
): Promise<{ status: number; body: SwapCandidates; error?: CandidatesError }> {
  const { status, body } = await harness.json<{ candidates: SwapCandidates } & CandidatesError>(
    `/api/slots/${slotId}/candidates`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return status === 200
    ? { status, body: body.candidates }
    : { status, body: undefined as unknown as SwapCandidates, error: body };
}

async function getSlot(slotId = SLOT): Promise<{ slot: SlotWithPortion; history: MealEvent[] }> {
  const { status, body } = await harness.json<SlotResponse>(`/api/slots/${slotId}`);
  expect(status).toBe(200);
  return body;
}

/** 直接往事件流里塞一餐（模拟「最近吃过」；append-only 的库只能插不能改） */
function seedMeal(date: string, recipeIds: string[]): void {
  const [slotDate, meal] = date.split(':') as [string, 'lunch' | 'dinner'];
  harness.db
    .prepare(
      `INSERT INTO meal_events (slot_id, slot_date, meal, type, source, occurred_at)
       VALUES (?, ?, ?, 'decide', 'manual', ?)`,
    )
    .run(date, slotDate, meal, `${slotDate}T04:00:00.000Z`);
  const seq = Number((harness.db.prepare('SELECT last_insert_rowid() AS seq').get() as { seq: number }).seq);
  const insert = harness.db.prepare(
    'INSERT INTO meal_event_dishes (seq, position, recipe_id, keep_leftover) VALUES (?, ?, ?, 0)',
  );
  recipeIds.forEach((recipeId, index) => insert.run(seq, index, recipeId));
}

const DINNERS = ['mom', 'dad', 'dabao', 'xiaobao'];
const DINNER_DISHES = ['hongshaopaigu', 'suanrongcaixin', 'dongguapaigutang'];
/** 一餐里没有虾的普通菜单（换菜测试的起点；要验忌口时另加白灼虾） */
async function seedDinner(dishes: string[] = DINNER_DISHES): Promise<void> {
  await book({ diners: DINNERS, dishes: dishes.map((recipeId) => ({ recipeId })) });
}

describe('候选：同位替换与池子筛选', () => {
  it('一次给 3 个候选，各带一句理由；只从同位（荤→荤）里挑', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    const { status, body } = await candidates({ replacing: 'hongshaopaigu' });
    expect(status).toBe(200);
    expect(body.slotId).toBe(SLOT);
    expect(body.replacing).toEqual({ recipeId: 'hongshaopaigu', name: '红烧排骨', kind: 'meat' });
    expect(body.candidates).toHaveLength(3);
    expect(body.candidates.every((candidate) => candidate.kind === 'meat')).toBe(true);
    expect(body.candidates.every((candidate) => (candidate.reason ?? '').length > 0)).toBe(true);
    // 被换掉的那道不进候选（「换成它自己」是一次空操作）
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('hongshaopaigu');
    // 这餐已经在桌上的别的菜也不进候选
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('suanrongcaixin');
  });

  it('候选池是「同位」而不是「整餐」：换汤位给的也是汤位（荤汤素汤都算汤）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    const { body } = await candidates({ replacing: 'dongguapaigutang' });
    expect(body.candidates.map((candidate) => candidate.kind)).toContain('soup_veg');
    expect(body.candidates.every((candidate) => candidate.kind.startsWith('soup'))).toBe(true);
  });

  it('候选走 LLM 管线：池子与「换哪道菜」都是 prompt 的机器可读段落，fake 靠它确定性挑选', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    const { body } = await candidates({ replacing: 'hongshaopaigu' });
    const prompt = harness.llm.completionCalls[0]!.request.prompt;
    const swap = parsePromptSwap(prompt)!;
    expect(swap.replacing.recipeId).toBe('hongshaopaigu');
    expect(swap.count).toBe(3);
    expect(swap.date).toBe('2025-06-01');

    const pool = parsePromptCandidates(prompt);
    expect(pool.length).toBeGreaterThanOrEqual(3);
    expect(pool.every((entry) => entry.kind === 'meat')).toBe(true);
    // fake 按池子前 3 个出（确定性），响应与池子前 3 个一致
    expect(body.candidates.map((candidate) => candidate.recipeId)).toEqual(pool.slice(0, 3).map((entry) => entry.id));
    // 池子里没有忌口菜（硬过滤在入 prompt 之前）
    expect(prompt).not.toContain('白灼虾');
  });

  it('菜品带 origin：家庭菜标 family、外部补位菜标 external（界面据此显示「没做过」）', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 把荤位家庭菜塞进近 7 天窗口，只剩 2 道 → 需要外部补位
    seedMeal('2025-05-30:lunch', ['kelejichi', 'qingzhengluyu', 'tudouniuniu', 'tangculiji', 'chongcaohuazhengji']);
    await seedDinner(['hongshaopaigu', 'suanrongcaixin']);

    const { body } = await candidates({ replacing: 'hongshaopaigu' });
    const origins = body.candidates.map((candidate) => candidate.origin);
    expect(origins).toContain('external');
    expect(origins).toContain('family');
    // 外部补位菜来自草稿态的外部池（宫保鸡丁/回锅肉/番茄牛腩 + 002 就有的香菇滑鸡）
    const external = body.candidates.find((candidate) => candidate.origin === 'external')!;
    expect(['gongbaojiding', 'huiguorou', 'fanqieniunan', 'xiangguhuaji']).toContain(external.recipeId);
  });
});

describe('忌口：硬过滤 + 排除原因', () => {
  it('小宝忌虾：白灼虾进 excluded 并带原因「小宝忌虾」，绝不进候选', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    const { body } = await candidates({ replacing: 'hongshaopaigu' });
    const excluded = body.excluded.find((entry) => entry.recipeId === 'baizhuoxia');
    expect(excluded).toBeDefined();
    expect(excluded?.name).toBe('白灼虾');
    expect(excluded?.reason).toBe('小宝忌虾');
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('baizhuoxia');
  });

  it('忌口永远不放宽：把荤位的菜全忌掉时宁可 409，也不端上过敏原', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 让爸爸忌掉全部荤菜的主料（含外部池的三道）——荤位一个候选都剩不下
    const avoid = [
      'pork_ribs',
      'chicken_wings',
      'seabass',
      'beef_brisket',
      'pork_tenderloin',
      'chicken_legs',
      'pork_belly',
      'shrimp',
      'tomato',
    ];
    const patched = await harness.json(`/api/members/dad`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avoid }),
    });
    expect(patched.status).toBe(200);
    await seedDinner(['hongshaopaigu', 'suanrongcaixin']);

    const { status, error } = await candidates({ replacing: 'hongshaopaigu' });
    expect(status).toBe(409);
    expect(error?.error).toBe('no_candidates');
    // 别的位子上还有的是菜：这条 409 真的来自荤位全被忌口，而不是整库空了
    const veg = await candidates({ replacing: 'suanrongcaixin' });
    expect(veg.status).toBe(200);
    expect(veg.body.candidates.length).toBeGreaterThan(0);
  });

  it('双向对照：同一道蚝油生菜，小宝在席时说「小宝忌贝类」，不在席时正常进候选', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    const withChild = await candidates({ replacing: 'suanrongcaixin' });
    expect(withChild.body.excluded.find((entry) => entry.recipeId === 'haoyoushengcai')?.reason).toBe('小宝忌贝类');

    harness.llm.clearCalls();
    const adultsOnly = await candidates({ replacing: 'suanrongcaixin', diners: ['mom', 'dad'] });
    // 大人不忌贝类：蚝油生菜可进候选（隐性忌口经「含」指针展开只在命中时排除）
    const pool = parsePromptCandidates(harness.llm.completionCalls[0]!.request.prompt);
    expect(pool.map((entry) => entry.id)).toContain('haoyoushengcai');
    expect(adultsOnly.body.excluded.map((entry) => entry.recipeId)).not.toContain('haoyoushengcai');
  });

  it('忌「猪肉」→ 含猪里脊的菜也进 excluded 并说清原因（story 2 在换菜这条路上的同一条机制）', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 这位家人只忌基础类「猪肉」——细类菜要跟着出局，且原因要说得出
    const avoider = await seedAvoider(harness, { name: '姥姥', emoji: '👵', avoid: ['pork'] });
    await seedDinner(['kelejichi', 'suanrongcaixin']);

    // 换的是**荤位**（可乐鸡翅）——excluded 只列同位（荤位）的菜，而细类猪菜都在荤位。
    // 糖醋里脊用里脊（含猪肉），应被基础类「猪肉」排掉。
    const { status, body } = await candidates({ replacing: 'kelejichi', diners: [avoider] });
    expect(status).toBe(200);

    const tenderloin = body.excluded.find((entry) => entry.recipeId === 'tangculiji');
    expect(tenderloin?.reason).toBe('姥姥忌猪肉');
    // 红烧排骨（猪排骨）同样被基础类排掉——这是 story 2 点名的那道菜
    const ribs = body.excluded.find((entry) => entry.recipeId === 'hongshaopaigu');
    expect(ribs?.reason).toBe('姥姥忌猪肉');
    // excluded 与 candidates 是同一个同位集合的两面：被排掉的绝不在候选里
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('tangculiji');
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('hongshaopaigu');

    // 反向对照：不忌猪肉的人这两道菜都不在 excluded 里（否则上面那两条可能因为别的原因成立）
    harness.llm.clearCalls();
    const normal = await candidates({ replacing: 'kelejichi' });
    expect(normal.body.excluded.map((entry) => entry.recipeId)).not.toContain('tangculiji');
    expect(normal.body.excluded.map((entry) => entry.recipeId)).not.toContain('hongshaopaigu');
  });

  it('「再换一个」的会话排除会换出新的一批；exclude 累积后池干就放宽（relaxed=session）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    const first = await candidates({ replacing: 'hongshaopaigu' });
    const firstIds = first.body.candidates.map((candidate) => candidate.recipeId);
    expect(first.body.relaxed).toBe('none');

    const second = await candidates({ replacing: 'hongshaopaigu', exclude: firstIds });
    const secondIds = second.body.candidates.map((candidate) => candidate.recipeId);
    // 同一会话内已出示的候选不再出现（池子还够时不重复）
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

    // 把剩下的荤位菜全排除掉 → 严格档空 → 放宽到 dedupe/session
    // （含草稿态的香菇滑鸡：它也在同位池里，只是单独出现时被当作外部补位）
    const rest = [
      'kelejichi',
      'qingzhengluyu',
      'tudouniuniu',
      'tangculiji',
      'chongcaohuazhengji',
      'huangmenji',
      'xiangguhuaji',
      'baizhuoxia',
      // 草稿态的荤菜（外部补位池）也在同位池里：要真的池干就一个都不能漏
      'gongbaojiding',
      'huiguorou',
      'fanqieniunan',
    ];
    const dry = await candidates({ replacing: 'hongshaopaigu', exclude: [...firstIds, ...secondIds, ...rest] });
    expect(dry.status).toBe(200);
    expect(dry.body.relaxed).toBe('session');
    expect(dry.body.candidates.map((candidate) => candidate.recipeId).some((id) => firstIds.includes(id))).toBe(true);
    expect(dry.body.notes.join('')).toMatch(/出示过|用完/);
    // 放宽也不会把忌口菜放回来
    expect(dry.body.candidates.map((candidate) => candidate.recipeId)).not.toContain('baizhuoxia');
  });

  it('池干放宽分两层：先去重档（放回近 7 天做过的），再会话档（放回已出示过的）', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 家庭荤菜 8 道，吃掉 6 道 → 严格档还剩 1 道（白灼虾被忌口排除，实际剩黄焖鸡）
    seedMeal('2025-05-30:lunch', ['kelejichi', 'qingzhengluyu', 'tudouniuniu', 'tangculiji', 'chongcaohuazhengji']);
    await seedDinner(['hongshaopaigu', 'suanrongcaixin']);

    const first = await candidates({ replacing: 'hongshaopaigu' });
    expect(first.body.relaxed).toBe('none');
    const shown = first.body.candidates.map((candidate) => candidate.recipeId);

    // 把严格档剩下的也出示掉 → 只能放宽到 dedupe（放回刚吃过的那几道）
    const relaxed = await candidates({ replacing: 'hongshaopaigu', exclude: shown });
    expect(relaxed.body.relaxed).toBe('dedupe');
    expect(relaxed.body.candidates.length).toBeGreaterThan(0);
    expect(relaxed.body.notes.join('')).toMatch(/近 7 天|刚做过/);
  });
});

describe('候选的 LLM 降级链（spec S7 的同一条链）', () => {
  it('LLM 全失败 → 规则排序 top3，理由为 null、degraded/format 可观测', async () => {
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可用'));
    await seedDinner();

    const { status, body } = await candidates({ replacing: 'hongshaopaigu' });
    expect(status).toBe(200);
    expect(harness.llm.completionCalls).toHaveLength(4); // 两档各重试 1 次
    expect(body.llm.format).toBe('rules_only');
    expect(body.llm.degraded).toBe(true);
    expect(body.llm.promptVersion).toMatch(/candidate/);
    expect(body.candidates).toHaveLength(3);
    // 简化候选不编理由（没有 LLM 参与的时刻，界面上写一句「为什么推这道」是撒谎）
    expect(body.candidates.every((candidate) => candidate.reason === null)).toBe(true);
    expect(body.notes.join('')).toMatch(/规则排序|简化/);
    // 规则序仍然守着忌口与同位
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('baizhuoxia');
    expect(body.candidates.every((candidate) => candidate.kind === 'meat')).toBe(true);
  });

  it('LLM 给了池外的菜（幻觉）→ 判失败并降级；幻觉永不进候选', async () => {
    harness = createTestHarness();
    await seedDinner();
    harness.llm.setCompletion(
      JSON.stringify({ candidates: [{ recipeId: 'mianfeidewucan', reason: '编的' }] }),
    );

    const { body } = await candidates({ replacing: 'hongshaopaigu' });
    expect(body.llm.format).toBe('rules_only');
    expect(body.notes.join('')).toContain('候选池里没有的菜');
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('mianfeidewucan');
  });

  it('候选条数不足（池子够却只给 1 个）→ 判失败并降级为规则 top3', async () => {
    harness = createTestHarness();
    await seedDinner();
    harness.llm.setCompletion(JSON.stringify({ candidates: [{ recipeId: 'kelejichi', reason: '就它了' }] }));

    const { body } = await candidates({ replacing: 'hongshaopaigu' });
    expect(body.notes.join('')).toContain('候选条数不符');
    expect(body.candidates).toHaveLength(3);
  });

  it('同一次候选只有一次成功调用（第 1 次合法就不重试）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    await candidates({ replacing: 'hongshaopaigu' });
    expect(harness.llm.completionCalls).toHaveLength(1);
    expect(harness.llm.completionCalls[0]!.request.responseFormat).toBe('json_schema');
  });
});

describe('候选接口的入参与错误', () => {
  it('未定餐槽：带草稿菜单也能换（编辑器里的草稿还没落库）；不带草稿才 409', async () => {
    harness = createTestHarness();
    scriptLlm();

    const undecided = await candidates({ replacing: 'hongshaopaigu', diners: DINNERS });
    expect(undecided.status).toBe(409);
    expect(undecided.error?.error).toBe('slot_undecided');

    // 推荐面板里就是这条路：整套推荐还没落库，草稿菜单由客户端带上来（总纲 §4 推荐不落库）
    const withDraft = await candidates({
      replacing: 'hongshaopaigu',
      dishes: ['hongshaopaigu', 'fanqiechaodan', 'dongguapaigutang'],
      diners: DINNERS,
    });
    expect(withDraft.status).toBe(200);
    expect(withDraft.body.candidates).toHaveLength(3);
    // 草稿菜单里别的菜不进候选
    expect(withDraft.body.candidates.map((candidate) => candidate.recipeId)).not.toContain('fanqiechaodan');
  });

  it('要换的菜不在菜单里 → 400 dish_not_in_menu（指认是哪一道）', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    const { status, error } = await candidates({ replacing: 'kelejichi' });
    expect(status).toBe(400);
    expect(error?.error).toBe('dish_not_in_menu');
    expect(error?.recipeId).toBe('kelejichi');
  });

  it('含「待重标」项（0 克）的草稿不进候选池；重标成正数后能回来', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 荤位家庭菜塞进近 7 天窗口，逼出外部补位（与整餐推荐同一道口子）
    seedMeal('2025-05-30:lunch', ['kelejichi', 'qingzhengluyu', 'tudouniuniu', 'tangculiji', 'chongcaohuazhengji']);
    await seedDinner(['hongshaopaigu', 'suanrongcaixin']);

    // 两道荤位草稿（香菇滑鸡 / 番茄牛腩）里只有番茄牛腩变成「待重标」（0 克 = 模糊份量等 LLM 重标）
    harness.db
      .prepare("UPDATE recipes SET status = 'retired' WHERE id IN ('gongbaojiding', 'huiguorou')")
      .run();
    harness.db
      .prepare("UPDATE recipe_ingredients SET adult_grams = 0 WHERE recipe_id = 'fanqieniunan' AND ingredient_id = 'tomato'")
      .run();

    const { body } = await candidates({ replacing: 'hongshaopaigu' });
    // 不在候选、也不在「被忌口排除」清单里（它不是不能吃，是克数还没定）
    expect(body.candidates.map((candidate) => candidate.recipeId)).not.toContain('fanqieniunan');
    expect(body.excluded.map((entry) => entry.recipeId)).not.toContain('fanqieniunan');
    // 对照：同一批里克数齐的草稿照常候选（不是「草稿一律不进」）
    expect(body.candidates.map((candidate) => candidate.recipeId)).toContain('xiangguhuaji');

    // 重标成功（写回正数）后，同一道草稿回到候选池
    harness.db
      .prepare("UPDATE recipe_ingredients SET adult_grams = 120 WHERE recipe_id = 'fanqieniunan' AND ingredient_id = 'tomato'")
      .run();
    harness.llm.clearCalls();
    const after = await candidates({ replacing: 'hongshaopaigu' });
    expect(after.body.candidates.map((candidate) => candidate.recipeId)).toContain('fanqieniunan');
  });

  it('这餐过了截止时刻 → 400 slot_passed；餐槽 id 非法 → 400；名单里有人不存在 → 400', async () => {
    harness = createTestHarness();
    scriptLlm();

    const passed = await candidates({ replacing: 'hongshaopaigu', dishes: ['hongshaopaigu'] }, '2025-05-30:dinner');
    expect(passed.status).toBe(400);
    expect(passed.error?.error).toBe('slot_passed');

    const bad = await candidates({ replacing: 'hongshaopaigu', dishes: ['hongshaopaigu'] }, '2025-06-01:brunch');
    expect(bad.status).toBe(400);
    expect(bad.error?.error).toBe('invalid_slot_id');

    await seedDinner();
    const unknown = await candidates({ replacing: 'hongshaopaigu', diners: ['nobody'] });
    expect(unknown.status).toBe(400);
    expect(unknown.error?.error).toBe('unknown_member');
  });

  it('用餐者缺省 = 这一餐菜单的快照（不是全体家人）：先把虾定上桌，不传名单也仍按小宝忌虾排除', async () => {
    harness = createTestHarness();
    scriptLlm();
    // 这一餐只给妈妈吃（名单快照里没有小宝）——缺省名单该跟它，而不是全体家人
    await book({ diners: ['mom'], dishes: [{ recipeId: 'baizhuoxia' }, { recipeId: 'suanrongcaixin' }] });

    const { body } = await candidates({ replacing: 'baizhuoxia' });
    // 妈妈不忌虾：白灼虾只是「被换掉的那道」而不进 excluded（它被 context.menu 排掉了）
    expect(body.excluded.map((entry) => entry.recipeId)).not.toContain('baizhuoxia');
    expect(body.excluded.map((entry) => entry.recipeId)).not.toContain('haoyoushengcai');

    // 对照：换素位那道、且把「小宝」加进名单，蚝油生菜（小宝忌贝类）就进 excluded 了
    harness.llm.clearCalls();
    const withChild = await candidates({ replacing: 'suanrongcaixin', diners: ['mom', 'xiaobao'] });
    expect(withChild.body.excluded.find((entry) => entry.recipeId === 'haoyoushengcai')?.reason).toBe('小宝忌贝类');
  });

  it('候选不改状态也不落库：连续两次候选不追事件', async () => {
    harness = createTestHarness();
    scriptLlm();
    await seedDinner();

    await candidates({ replacing: 'hongshaopaigu' });
    await candidates({ replacing: 'hongshaopaigu' });
    expect((await getSlot()).history.map((event) => event.type)).toEqual(['decide']);
  });
});
