import type { MemberProfile, RecentDish, Recipe, RecipeKind, RecommendationStructure } from '../wire-types.js';

/**
 * 推荐 prompt（总纲 §4②，ADR-0001：LLM 只从检索池中选与搭配）。
 *
 * 三条纪律：
 *
 * 1. **模板进代码库、版本号进留痕**（总纲 §3 决议 3）。改了这个文件的措辞就改
 *    `PROMPT_VERSION`——留痕里存的是版本号，历史推荐要能对回当时的模板。
 * 2. **机器可读段落在 prompt 里显式分节**：结构指令与候选池各是一段紧凑 JSON，
 *    前后用标记行隔开。理由有二：① LLM 在长中文自然语言里找结构约束容易漏；
 *    ② 测试与 E2E 的 fake LLM 要能从 prompt 里**确定性地**读出池子（E2E 不能依赖真 LLM）。
 *    这些标记行不是给模型的装饰，是接口。
 * 3. **食材/做法不进 prompt**：LLM 不需要知道克数（份量是后端查表，ADR-0004），
 *    给多了只会增加幻觉面。只给「id/菜名/位/主料/近 30 天次数/来源」。
 */

/** 改了 prompt 措辞或池子形状就 +1（留痕里的版本号，历史推荐靠它对回当时的模板） */
export const PROMPT_VERSION = '2026-09-rec-v1';

export const SYSTEM_PROMPT = [
  '你是一位中国家庭的日常配餐助手。你的唯一任务是从给定的候选池中挑选并搭配一餐。',
  '严格遵守：',
  '1. 只能选候选池里的菜（用它的 id），不得创造任何新菜，不得重复选同一道菜。',
  '2. 必须正好选够【本餐结构】要求的道数，并满足其中每个荤素位的数量。',
  '3. 每位用餐者的忌口已在后端硬过滤，池中不会出现忌口菜；但如果有明确的「近 7 天已吃」，',
  '   在能选到别的菜时尽量避开同样的主料。',
  '4. 兼顾时令与口味搭配：一餐里不要都是同一种口味，尽量有清淡有咸鲜。',
  '5. 每道菜给**一句**中文理由（20 字以内，说清为什么这餐配它），不要复述做法。',
  '输出只能是 JSON，不要 markdown 代码块，不要解释文字。JSON 形状：',
  '{"dishes":[{"recipeId":"<候选池里的 id>","reason":"<一句理由>"}]}',
].join('\n');

/** 一块候选池：同一个荤素位的家庭菜 vs 外部补位菜（来源分开给，LLM 优先选做过的） */
export interface PoolEntry {
  id: string;
  name: string;
  kind: RecipeKind;
  /** 主料名（取食材清单前 2 项，给 LLM 判断搭配是否重样） */
  mains: string[];
  origin: 'family' | 'external';
  /** 近 30 天做过几次（0 = 没做过；外部补位菜恒 0） */
  times30d: number;
}

export interface PromptInput {
  slot: { date: string; meal: 'lunch' | 'dinner' };
  structure: RecommendationStructure;
  diners: MemberProfile[];
  pool: PoolEntry[];
  /** 近 7 天已吃的菜（软避让，总纲 §4①） */
  recentDishes: RecentDish[];
  /** 近 30 天反馈摘要（#20 落数据，本票接口留好位置：非空就写进 prompt） */
  feedbackSummary?: string[];
}

/** 【本餐结构】的机器可读段落形状（E2E 的 fake 就靠它知道要选几道） */
export interface PromptStructureBlock {
  date: string;
  meal: 'lunch' | 'dinner';
  adults: number;
  children: number;
  need: { meat: number; veg: number; soup: number };
  total: number;
}

export const STRUCTURE_MARK = '【本餐结构】';
export const POOL_MARK = '【候选池】';
export const RECENT_MARK = '【近 7 天已吃】';
export const PROFILE_MARK = '【家人画像】';

export function buildPrompt(input: PromptInput): { system: string; prompt: string; structure: PromptStructureBlock } {
  const structure: PromptStructureBlock = {
    date: input.slot.date,
    meal: input.slot.meal,
    adults: input.structure.adults,
    children: input.structure.children,
    need: { meat: input.structure.meat, veg: input.structure.veg, soup: input.structure.soup },
    total: input.structure.meat + input.structure.veg + input.structure.soup,
  };

  const lines: string[] = [
    `${PROFILE_MARK}`,
    ...profileLines(input.diners),
    '',
    `${RECENT_MARK}`,
    input.recentDishes.length === 0
      ? '（近 7 天没做过这些菜）'
      : input.recentDishes.map((dish) => `${dish.name}（${mealLabel(dish.meal)}，${dish.date}）`).join('、'),
  ];

  if (input.feedbackSummary && input.feedbackSummary.length > 0) {
    lines.push('', '【近 30 天反馈】', input.feedbackSummary.join('；'));
  }

  lines.push(
    '',
    STRUCTURE_MARK,
    JSON.stringify(structure),
    '',
    POOL_MARK,
    JSON.stringify(input.pool.map(poolLine)),
    '',
    `请从【候选池】中选 ${structure.total} 道（荤 ${structure.need.meat} / 素 ${structure.need.veg} / 汤 ${structure.need.soup}），输出 JSON。`,
  );

  return { system: SYSTEM_PROMPT, prompt: lines.join('\n'), structure };
}

/** 池子条目落进 prompt 的形状：短键、无 null，模型不需要的东西一律不给 */
function poolLine(entry: PoolEntry): Record<string, unknown> {
  const line: Record<string, unknown> = {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    main: entry.mains.join('/'),
    source: entry.origin === 'family' ? '家庭常做' : '外部（没做过）',
  };
  if (entry.times30d > 0) line.times30d = entry.times30d;
  return line;
}

/**
 * 画像段用自然语言（总纲 §4②要求），但只写**软信号**：爱吃与人数。
 * 忌口是硬过滤、已经在池子外拦掉了，写进 prompt 只会让模型自作聪明地再筛一遍。
 */
function profileLines(diners: MemberProfile[]): string[] {
  const adults = diners.filter((member) => member.kind === 'adult').length;
  const children = diners.filter((member) => member.kind === 'child').length;
  const loves = [...new Set(diners.flatMap((member) => member.loves.map((entry) => entry.name)))];
  return [
    `本餐用餐者：${diners.map((member) => member.name).join('、')}（大人 ${adults}、小孩 ${children}）。`,
    loves.length > 0 ? `他们爱吃：${loves.join('、')}。` : '没有特别的偏爱记录。',
  ];
}

function mealLabel(meal: 'lunch' | 'dinner'): string {
  return meal === 'lunch' ? '午餐' : '晚餐';
}

/**
 * 从 prompt 里把候选池读回来。**测试与 E2E 的 fake LLM 用它**做出确定性的选择——
 * 所以它必须只看 prompt 本身（不看闭包外的状态），这样「LLM 收到什么 → 回什么」
 * 在断言里可复现。
 */
export function parsePromptPool(prompt: string): PoolEntry[] {
  const block = sectionAfter(prompt, POOL_MARK);
  if (!block) return [];
  try {
    const raw = JSON.parse(block) as { id: string; name: string; kind: RecipeKind; main?: string; source?: string }[];
    return raw.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      mains: entry.main ? entry.main.split('/') : [],
      origin: entry.source === '外部（没做过）' ? 'external' : 'family',
      times30d: 0,
    }));
  } catch {
    return [];
  }
}

/** 同上，结构段 */
export function parsePromptStructure(prompt: string): PromptStructureBlock | undefined {
  const block = sectionAfter(prompt, STRUCTURE_MARK);
  if (!block) return undefined;
  try {
    return JSON.parse(block) as PromptStructureBlock;
  } catch {
    return undefined;
  }
}

/**
 * 按 prompt 里的池子做一次**确定性的**挑选（结构合法、重样不选）。
 *
 * 谁用它：`createFakeLlmClient()` 的缺省出参——测试与 E2E 需要「LLM 从池中选」这个行为本身，
 * 但不该依赖真模型（真模型不确定、要钱、要网）。返回值是 `{dishes:[{recipeId,reason}]}` 的 JSON 文本；
 * prompt 里没池子就返回 undefined（fake 回落到回显，那些用例本来就不关心选菜）。
 */
export function pickPoolSelection(prompt: string): string | undefined {
  const structure = parsePromptStructure(prompt);
  const pool = parsePromptPool(prompt);
  if (!structure || pool.length === 0) return undefined;

  const want: Record<'meat' | 'veg' | 'soup', number> = { ...structure.need };
  const taken: Record<'meat' | 'veg' | 'soup', number> = { meat: 0, veg: 0, soup: 0 };
  const dishes: { recipeId: string; reason: string }[] = [];
  for (const entry of pool) {
    const position = positionOfKind(entry.kind);
    if (taken[position] >= want[position]) continue;
    taken[position] += 1;
    dishes.push({ recipeId: entry.id, reason: `${entry.name} 补上这餐的${POSITION_LABEL[position]}。` });
  }

  return JSON.stringify({ dishes });
}

const POSITION_LABEL = { meat: '荤菜', veg: '素菜', soup: '汤' } as const;

/** 荤素位归一：`soup_meat` / `soup_veg` 都是汤位（与 domain/recommendation.ts 同一口径） */
function positionOfKind(kind: RecipeKind): 'meat' | 'veg' | 'soup' {
  if (kind === 'meat') return 'meat';
  if (kind === 'veg') return 'veg';
  return 'soup';
}

/** 取标记行之后的那一段（到下一个标记行或空行为止） */
function sectionAfter(prompt: string, mark: string): string | undefined {
  const lines = prompt.split('\n');
  const start = lines.findIndex((line) => line.trim() === mark);
  if (start === -1) return undefined;
  const body = lines[start + 1];
  return body?.trim() === '' ? undefined : body?.trim();
}

/**
 * 容忍 LLM 的常见走样：markdown 代码块包裹、前后多余文字。
 * **只做这一层清洗**——形状是否合法交给上层的 Zod（llm/recommendation-schema.ts），
 * 夹中间再发明一层「友好解析」会让「schema 校验失败」这条路径永远走不到。
 */
export function stripCodeFence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1]!.trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text.trim();
}

// ---------------------------------------------------------------- 规则候选池

/**
 * 规则排序（简化推荐、「LLM 不可用」、以及候选池内部的优先序都走它）：
 * 时令命中优先 → 近 30 天没做过优先 → 爱吃命中优先 → 快手优先 → 名字稳定序。
 * 全是可解释的信号，没有数值权重（ADR-0005），没有随机（同一库同一餐结果可复现）。
 *
 * 时令的判定：菜谱自己的适季月份命中当月的（seed 里 `soup` 类菜写明 6–9 月这种），
 * 或者它的食材里有当月时令食材。两个来源合并而不二选一：菜谱的适季月份是人手标上去的强信号，
 * 食材的时令是字典级的弱信号——醋溜白菜没标月份，但白菜在 11–2 月时令，它就该排前面。
 */
export function rankPool(
  recipes: Recipe[],
  context: {
    month: number;
    recentDishIds: Set<string>;
    loves: Set<string>;
    /** 当月时令食材 id（`seasonalIngredientIds(db, month)`）；不传 = 不看食材时令 */
    seasonalIngredients?: Set<string>;
  },
): Recipe[] {
  const seasonal = context.seasonalIngredients ?? new Set<string>();
  return [...recipes].sort((a, b) => {
    const score = (recipe: Recipe): number => {
      let value = 0;
      if (recipe.seasonMonths.includes(context.month)) value += 8;
      else if (recipe.ingredients.some((item) => seasonal.has(item.ingredientId))) value += 4;
      if (!context.recentDishIds.has(recipe.id)) value += 3;
      if (recipe.ingredients.some((item) => context.loves.has(item.ingredientId)) || context.loves.has(recipe.id)) {
        value += 2;
      }
      if (recipe.effort === 'quick') value += 1;
      return value;
    };
    const diff = score(b) - score(a);
    return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh');
  });
}
