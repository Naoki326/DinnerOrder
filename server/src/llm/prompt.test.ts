import { describe, expect, it } from 'vitest';
import {
  buildCandidatePrompt,
  buildPrompt,
  CANDIDATE_PROMPT_VERSION,
  parsePromptCandidates,
  parsePromptPool,
  parsePromptStructure,
  parsePromptSwap,
  pickCandidateSelection,
  pickLlmSelection,
  pickPoolSelection,
  PROMPT_VERSION,
  promptVersionFor,
  rankPool,
  STRUCTURE_MARK,
  SYSTEM_PROMPT,
} from './prompt.js';
import type { MemberProfile, RecentDish, Recipe, RecommendationStructure } from '../wire-types.js';

/**
 * prompt 模板是**接口**，不是文案：结构段与候选池段被 fake LLM 与 E2E 解析（见 prompt.ts 文件头），
 * 所以它们的形状有测试兜住；同时这里守住几条纪律（不写步骤、不写克数、忌口不进 prompt）。
 */
function member(overrides: Partial<MemberProfile> = {}): MemberProfile {
  return {
    id: 'mom',
    name: '妈妈',
    emoji: '👩',
    kind: 'adult',
    gender: 'female',
    birthMonth: null,
    isCook: true,
    avoid: [{ ingredientId: 'offal', name: '动物内脏' }],
    loves: [{ kind: 'ingredient', id: 'seabass', name: '鲈鱼' }],
    ...overrides,
  };
}

function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    name: id,
    aliases: [],
    kind: 'meat',
    tastes: ['咸鲜'],
    seasonMonths: [],
    avoidIngredientIds: [],
    effort: 'medium',
    status: 'active',
    source: 'oral',
    steps: '这是做法步骤，绝不该进 prompt',
    ingredients: [
      { ingredientId: 'pork_ribs', name: '猪排骨', adultGrams: 150, scaling: 'linear', rawCookedAnchor: null },
      { ingredientId: 'salt', name: '盐', adultGrams: 2, scaling: 'fixed', rawCookedAnchor: null },
    ],
    ...overrides,
  };
}

const STRUCTURE: RecommendationStructure = { adults: 2, children: 2, meat: 2, veg: 1, soup: 1 };

describe('prompt 组装', () => {
  const input = {
    slot: { date: '2025-06-01', meal: 'dinner' as const },
    structure: STRUCTURE,
    diners: [member(), member({ id: 'xiaobao', name: '小宝', kind: 'child', isCook: false })],
    pool: [
      { id: 'hongshaopaigu', name: '红烧排骨', kind: 'meat' as const, mains: ['猪排骨'], origin: 'family' as const, times30d: 3 },
      { id: 'gongbaojiding', name: '宫保鸡丁', kind: 'meat' as const, mains: ['鸡腿'], origin: 'external' as const, times30d: 0 },
    ],
    recentDishes: [
      {
        recipeId: 'kelejichi',
        name: '可乐鸡翅',
        kind: 'meat' as const,
        slotId: '2025-05-30:dinner',
        date: '2025-05-30',
        meal: 'dinner' as const,
        times: 1,
      },
    ],
  };

  it('带上版本号与系统提示，且要求只输出 JSON', () => {
    const { system, prompt } = buildPrompt(input);
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}/);
    expect(system).toContain('JSON');
    expect(system).toContain('不要 markdown 代码块');
    expect(prompt).toContain(STRUCTURE_MARK);
  });

  it('结构段与池子段是机器可读 JSON，能被解回来（fake 与 E2E 依赖这一点）', () => {
    const { prompt } = buildPrompt(input);
    expect(parsePromptStructure(prompt)).toEqual({
      date: '2025-06-01',
      meal: 'dinner',
      adults: 2,
      children: 2,
      need: { meat: 2, veg: 1, soup: 1 },
      total: 4,
    });
    const pool = parsePromptPool(prompt);
    expect(pool.map((entry) => entry.id)).toEqual(['hongshaopaigu', 'gongbaojiding']);
    expect(pool[1]).toMatchObject({ origin: 'external', mains: ['鸡腿'] });
  });

  it('近 7 天已吃进 prompt 作软避让；没有时写一句明确的话而不是留空', () => {
    expect(buildPrompt(input).prompt).toContain('可乐鸡翅');
    const empty = buildPrompt({ ...input, recentDishes: [] }).prompt;
    expect(empty).toContain('近 7 天没做过这些菜');
  });

  it('画像段只写软信号：人数与爱吃；忌口是硬过滤、不进 prompt', () => {
    const { prompt } = buildPrompt(input);
    // 人数按用餐者名单现算（这条喂进来的是 1 大 1 小）
    expect(prompt).toContain('大人 1、小孩 1');
    expect(prompt).toContain('鲈鱼');
    expect(prompt).not.toContain('动物内脏');
  });

  it('做法步骤与克数绝不进 prompt（ADR-0004：份量不经 LLM）', () => {
    const { prompt } = buildPrompt({ ...input, diners: [member()] });
    expect(prompt).not.toContain('这是做法步骤');
    expect(prompt).not.toContain('adultGrams');
    expect(prompt).not.toContain('150');
  });

  it('近 30 天次数只在非零时写（0 次的菜不写一行噪音）', () => {
    const { prompt } = buildPrompt(input);
    expect(prompt).toContain('"times30d":3');
    expect(prompt).not.toContain('"times30d":0');
  });

  it('近 30 天反馈摘要有内容时才进 prompt（#20 会往里填）', () => {
    expect(buildPrompt({ ...input, feedbackSummary: ['红烧排骨：太油'] }).prompt).toContain('太油');
    expect(buildPrompt(input).prompt).not.toContain('近 30 天反馈');
  });
});

describe('fake 的确定性挑选（pickPoolSelection）', () => {
  it('从 prompt 的池子里按结构选满，每道给一句理由', () => {
    const { prompt } = buildPrompt({
      slot: { date: '2025-06-01', meal: 'dinner' },
      structure: STRUCTURE,
      diners: [member()],
      pool: [
        { id: 'hongshaopaigu', name: '红烧排骨', kind: 'meat', mains: ['猪排骨'], origin: 'family', times30d: 1 },
        { id: 'kelejichi', name: '可乐鸡翅', kind: 'meat', mains: ['鸡翅'], origin: 'family', times30d: 0 },
        { id: 'fanqiechaodan', name: '番茄炒蛋', kind: 'veg', mains: ['番茄'], origin: 'family', times30d: 2 },
        { id: 'dongguapaigutang', name: '冬瓜排骨汤', kind: 'soup_meat', mains: ['冬瓜'], origin: 'family', times30d: 0 },
      ],
      recentDishes: [],
    });

    const selection = JSON.parse(pickPoolSelection(prompt)!) as { dishes: { recipeId: string; reason: string }[] };
    expect(selection.dishes.map((dish) => dish.recipeId)).toEqual([
      'hongshaopaigu',
      'kelejichi',
      'fanqiechaodan',
      'dongguapaigutang',
    ]);
    expect(selection.dishes.every((dish) => dish.reason.length > 0)).toBe(true);
  });

  it('池子不够就只选能选的（不编造池外的菜）', () => {
    const { prompt } = buildPrompt({
      slot: { date: '2025-06-01', meal: 'dinner' },
      structure: { adults: 2, children: 0, meat: 2, veg: 1, soup: 1 },
      diners: [member()],
      pool: [{ id: 'fanqiechaodan', name: '番茄炒蛋', kind: 'veg', mains: ['番茄'], origin: 'family', times30d: 0 }],
      recentDishes: [],
    });
    const selection = JSON.parse(pickPoolSelection(prompt)!) as { dishes: { recipeId: string }[] };
    expect(selection.dishes.map((dish) => dish.recipeId)).toEqual(['fanqiechaodan']);
  });

  it('不是推荐 prompt（没有池子段）时返回 undefined，fake 回落到回显', () => {
    expect(pickPoolSelection('随便一段没有标记的文本')).toBeUndefined();
    expect(pickPoolSelection(SYSTEM_PROMPT)).toBeUndefined();
  });
});

describe('规则排序（简化推荐的那条路）', () => {
  const context = { month: 6, recentDishIds: new Set<string>(), loves: new Set<string>() };

  it('时令命中优先：菜谱自标月份 > 食材当季 > 其它', () => {
    const ranked = rankPool(
      [
        recipe('none'),
        recipe('inSeason', { seasonMonths: [6] }),
        recipe('byIngredient', {
          ingredients: [
            { ingredientId: 'tomato', name: '番茄', adultGrams: 120, scaling: 'linear', rawCookedAnchor: null },
          ],
        }),
      ],
      { ...context, seasonalIngredients: new Set(['tomato']) },
    );
    expect(ranked.map((item) => item.id)).toEqual(['inSeason', 'byIngredient', 'none']);
  });

  it('爱吃命中优先（食材粒度或菜粒度都算）', () => {
    const ranked = rankPool([recipe('plain'), recipe('loved'), recipe('lovedIngredient')], {
      month: 6,
      recentDishIds: new Set(),
      loves: new Set(['loved', 'pork_ribs']),
    });
    expect(ranked[ranked.length - 1]!.id).toBe('plain');
  });

  it('快手优先、名字稳定序收尾（同一库两次排序结果一致）', () => {
    const a = recipe('aaa', { effort: 'quick' });
    const b = recipe('bbb', { effort: 'medium' });
    const ranked = rankPool([b, a], context);
    expect(ranked.map((item) => item.id)).toEqual(['aaa', 'bbb']);
    expect(rankPool([b, a], context).map((item) => item.id)).toEqual(rankPool([a, b], context).map((item) => item.id));
  });
});

describe('近 7 天已吃的窗口（软避让用）', () => {
  it('窗口内的菜排在没做过的后面，但不会被丢掉（软避让不是硬排除）', () => {
    const fresh = recipe('fresh');
    const eaten = recipe('eaten');
    const ranked = rankPool([eaten, fresh], { month: 6, recentDishIds: new Set(['eaten']), loves: new Set() });
    expect(ranked.map((item) => item.id)).toEqual(['fresh', 'eaten']);
  });

  it('RecentDish 的形状随 prompt 一起断言（它进 prompt 的那两段）', () => {
    const recent: RecentDish = {
      recipeId: 'kelejichi',
      name: '可乐鸡翅',
      kind: 'meat',
      slotId: '2025-05-30:dinner',
      date: '2025-05-30',
      meal: 'dinner',
      times: 2,
    };
    const { prompt } = buildPrompt({
      slot: { date: '2025-06-01', meal: 'dinner' },
      structure: STRUCTURE,
      diners: [member()],
      pool: [],
      recentDishes: [recent],
    });
    expect(prompt).toContain('可乐鸡翅（晚餐，2025-05-30）');
  });
});

/**
 * 换菜候选 prompt（spec §2.3）：与整餐推荐同一条「模板是接口」的纪律——
 * 【换菜请求】与【同位候选池】两段是 fake LLM 与 E2E 的解析对象，形状有测试兜住。
 */
describe('换菜候选 prompt', () => {
  const candidateInput = {
    slot: { date: '2025-06-01', meal: 'dinner' as const },
    replacing: { recipeId: 'hongshaopaigu', name: '红烧排骨', kind: 'meat' as const },
    count: 3,
    diners: [member()],
    pool: [
      { id: 'kelejichi', name: '可乐鸡翅', kind: 'meat' as const, mains: ['鸡翅'], origin: 'family' as const, times30d: 2 },
      { id: 'gongbaojiding', name: '宫保鸡丁', kind: 'meat' as const, mains: ['鸡腿'], origin: 'external' as const, times30d: 0 },
    ],
    recentDishes: [
      {
        recipeId: 'qingzhengluyu',
        name: '清蒸鲈鱼',
        kind: 'meat' as const,
        slotId: '2025-05-30:dinner',
        date: '2025-05-30',
        meal: 'dinner' as const,
        times: 1,
      },
    ],
  };

  it('用独立的候选模板与版本号（与整餐推荐分开，留痕才说得清是哪张模板）', () => {
    const { system, prompt } = buildCandidatePrompt(candidateInput);
    expect(CANDIDATE_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}/);
    expect(CANDIDATE_PROMPT_VERSION).not.toBe(PROMPT_VERSION);
    expect(system).toContain('JSON');
    expect(system).toContain('不要 markdown 代码块');
    // 候选是「替换一道」不是「配一整餐」：prompt 里说清了这一点
    expect(system).toContain('替一道菜');
    // 换菜请求没有结构约束，不该把【本餐结构】段搬进来
    expect(prompt).not.toContain(STRUCTURE_MARK);
  });

  it('【换菜请求】与【同位候选池】是机器可读段落，都能解回来', () => {
    const { prompt } = buildCandidatePrompt(candidateInput);
    expect(parsePromptSwap(prompt)).toEqual({
      date: '2025-06-01',
      meal: 'dinner',
      replacing: { recipeId: 'hongshaopaigu', name: '红烧排骨', kind: 'meat' },
      count: 3,
    });
    const pool = parsePromptCandidates(prompt);
    expect(pool.map((entry) => entry.id)).toEqual(['kelejichi', 'gongbaojiding']);
    expect(pool[1]).toMatchObject({ origin: 'external', mains: ['鸡腿'] });
  });

  it('近 7 天已吃与画像仍然进 prompt（软避让 + 爱吃），忌口不进（硬过滤已在池外）', () => {
    const { prompt } = buildCandidatePrompt(candidateInput);
    expect(prompt).toContain('清蒸鲈鱼');
    expect(prompt).toContain('鲈鱼');
    expect(prompt).not.toContain('动物内脏');
    // 做法步骤与克数绝不进 prompt（ADR-0004）
    expect(prompt).not.toContain('这是做法步骤');
    expect(prompt).not.toContain('adultGrams');
  });

  it('假的确定性挑选：按池子前 N 个出（N = 请求的候选数），每道一句理由', () => {
    const { prompt } = buildCandidatePrompt(candidateInput);
    const selection = JSON.parse(pickCandidateSelection(prompt)!) as {
      candidates: { recipeId: string; reason: string }[];
    };
    expect(selection.candidates.map((candidate) => candidate.recipeId)).toEqual(['kelejichi', 'gongbaojiding']);
    expect(selection.candidates.every((candidate) => candidate.reason.length > 0)).toBe(true);
  });

  it('池子不够就只给池子里那几个（不编造池外的菜）', () => {
    const { prompt } = buildCandidatePrompt({
      ...candidateInput,
      pool: [candidateInput.pool[0]!],
    });
    const selection = JSON.parse(pickCandidateSelection(prompt)!) as { candidates: { recipeId: string }[] };
    expect(selection.candidates.map((candidate) => candidate.recipeId)).toEqual(['kelejichi']);
  });

  it('两条路共用一个分发入口：候选 prompt 走候选、推荐 prompt 走整餐', () => {
    const { prompt: swapPrompt } = buildCandidatePrompt(candidateInput);
    expect(pickLlmSelection(swapPrompt)).toContain('"candidates"');

    const { prompt: recPrompt } = buildPrompt({
      slot: { date: '2025-06-01', meal: 'dinner' },
      structure: STRUCTURE,
      diners: [member()],
      pool: [{ id: 'fanqiechaodan', name: '番茄炒蛋', kind: 'veg', mains: ['番茄'], origin: 'family', times30d: 0 }],
      recentDishes: [],
    });
    expect(pickLlmSelection(recPrompt)).toContain('"dishes"');

    expect(pickLlmSelection('随便一段没有标记的文本')).toBeUndefined();
  });

  /**
   * 模板版本与产生它的那条路**绑定**。留痕只收它自己那张模板的版本号——
   * 「在已知集合里」不够（候选模板也是已知的，但它不产生 `PUT /api/slots/:id` 的留痕）。
   */
  it('模板版本按来源绑定：整餐推荐只认整餐模板，候选模板不落在任何来源下', () => {
    expect(promptVersionFor('recommendation')).toBe(PROMPT_VERSION);
    expect(promptVersionFor('recommendation')).not.toBe(CANDIDATE_PROMPT_VERSION);
    // 未知来源没有可接受的模板（旧客户端/未来新路：宁可拒收）
    expect(promptVersionFor('candidate')).toBeUndefined();
    expect(promptVersionFor('v-我自己编的')).toBeUndefined();
  });
});
