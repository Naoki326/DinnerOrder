import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import type { LlmClient } from '../llm/types.js';
import { buildPrompt, PROMPT_VERSION, rankPool, type PoolEntry } from '../llm/prompt.js';
import {
  checkSelection,
  positionOf,
  RECOMMENDATION_JSON_SCHEMA,
  type SelectionDish,
} from '../llm/recommendation-schema.js';
import { runSelectionChain } from '../llm/selection-chain.js';
import type {
  MealRecommendation,
  MemberProfile,
  RecentDish,
  Recipe,
  RecipeKind,
  RecipeOrigin,
  RecommendedDish,
  RecommendationStructure,
} from '../wire-types.js';
import { listMembers, resolveMembers } from './members.js';
import { seasonalIngredientIds } from './ingredients.js';
import { coolingDishes, feedbackSummary } from './feedback.js';
import { hasPendingRelabel, listRecipes } from './recipes.js';
import { parseDate } from './family-time.js';
import {
  hasMealPassed,
  InvalidSlotIdError,
  parseSlotId,
  recentDishes,
  SlotPassedError,
} from './slots.js';

/**
 * 整餐推荐管线（总纲 §4、ADR-0001）：规则检索 → LLM 从池中选 → 降级链。
 *
 * 分工严格照 ADR-0001：**取数（忌口硬过滤、时令排序、去重、结构）全部前置**，
 * LLM 只做「从池中选与搭配 + 一句理由」，输出只是菜谱 id（幻觉无处发生）；
 * 份量不经过 LLM（ADR-0004，那是纯查表）。
 *
 * 三段各自可测：
 *   * `buildPool` / `planStructure`：纯规则，给定库与时钟即确定。时令按**目标那一餐所在的月份**
 *     算（不是「现在几月」——今晚 23 点给明天晚餐点推荐，跨月就该按明天算）。
 *   * `selectWithLlm`：降级链（strict 重试 1 次 → json_object + Zod 重试 1 次 → 简化推荐），
 *     用 fake 的 completion 队列逐档覆盖。
 *   * `recommendMeal`：把两者拼起来，产出线上形状（wire-types 的 MealRecommendation）。
 *
 * **不落库、不缓存**（总纲 §4「不用缓存菜单」）：推荐是「点一下现算」的一次性结果，
 * 接受与否由用户的下一次 `PUT /api/slots/:id`（source='recommendation'）决定。
 *
 * 刻意不做的一件事：**未来已定的菜不进硬排除**（窗口只算「已经上桌」的餐，走 recentDishes）。
 * 一餐菜谱的去重语义是「为什么又吃这个」，明天的事由 #18 的换一整套/改餐去管——
 * 把「将来的计划」也算进「最近吃过」，会让 prompt 里那句「近 7 天已吃」变成谎话。
 */

/** 家庭池每位最多取多少道进候选（总纲 §4①：每位 6–8 道）
 * TODO(#26 统一收口)：进家规表。 */
export const MAX_FAMILY_PER_POSITION = 8;

/** 家庭池某位候选少于这个数就用外部菜谱池补位（总纲 §4①、spec S6）
 * TODO(#26 统一收口)：进家规表。 */
export const MIN_FAMILY_PER_POSITION = 3;

/**
 * 家规基线（总纲 §2.2：2 荤 1 素 1 汤，每 ±1 大人 → ±1 道菜）。
 *
 * TODO（归 #26 统一收口）：这几个常量与 `DEDUPE_DAYS`、`MIN/MAX_FAMILY_PER_POSITION`、
 * `LLM_TIMEOUT_MS` 都是实施者自定的值，spec §2.2/§4 说它们属家规（总纲 §3：「家规 = 一份
 * 可调的单例配置，全部可调」）。这些家规值归 #26 统一收口，搬进 `family_rules` 同一张单例表
 * （列求并集即可）。本仓已有四个值在表里：冷藏期天数（006，`domain/feedback.ts` 读）、
 * 午/晚两餐次截止时刻（006，`domain/slots.ts` 的 `hasMealPassed` 读）与留量上浮系数
 * （007，#22 落，读口见 `domain/family-rules.ts`）。这里不跟着改是**有意的**：#26 收口时
 * 一次把剩余的家规值搬完，免得两票各改一半、合并时再对一次账。
 */
const BASELINE = { meat: 2, veg: 1, soup: 1 } as const;
const BASELINE_ADULTS = 2;

/** 去重窗口（家规默认 7 天，总纲 §4）：窗口内上桌过的菜**硬排除**（换菜候选的池干放宽也用它）。
 * 同为家规值，一并归 #26 统一收口（进 `family_rules` 单例表，见上）。 */
export const DEDUPE_DAYS = 7;

/** 候选池的位：荤 / 素 / 汤；`soup_meat` 与 `soup_veg` 都算汤位（总纲 §2.8 的汤分荤素只为忌口） */
type Position = 'meat' | 'veg' | 'soup';
const POSITIONS: Position[] = ['meat', 'veg', 'soup'];

export interface RecommendationOptions {
  /** 用餐者（member id）；不给 = 全体家人（与定餐编辑器的默认同一口径） */
  diners?: string[];
}

/**
 * 按这餐的用餐者忌口与 7 天去重后，一道候选都没有了。
 * 这是家人的**真实处境**（比如小宝刚忌了虾、荤位又都在去重窗口里），不是程序错误——
 * 所以给一句能行动的话，而不是折出一份空菜单。
 */
export class NoCandidatesError extends Error {
  constructor(readonly slotId: string) {
    super('按这餐的用餐者忌口与近 7 天去重后，没有可选的菜了：换个用餐者名单，或过几天再试。');
    this.name = 'NoCandidatesError';
  }
}

export async function recommendMeal(
  db: Db,
  clock: Clock,
  llm: LlmClient,
  id: string,
  options: RecommendationOptions = {},
): Promise<MealRecommendation> {
  const parsed = parseSlotId(id);
  if (!parsed) throw new InvalidSlotIdError(id);
  if (hasMealPassed(db, clock, parsed.date, parsed.meal)) throw new SlotPassedError(id);

  const diners = resolveDiners(db, options.diners);
  // 时令月份按目标那一餐的日期取（不是「今天」）
  const month = parseDate(parsed.date)!.month;
  // 两份窗口口径不同，别合并：「近 7 天」决定谁不能进池，「近 30 天次数」只是给 LLM 的软信号
  const recent = recentDishes(db, clock, DEDUPE_DAYS);
  const times30d = new Map(recentDishes(db, clock, 30).map((dish) => [dish.recipeId, dish.times]));
  // 冷藏期是**硬排除**（ADR-0005）：点踩过的菜在窗口内不进推荐，且与忌口一样在入池前就排掉
  const cooling = coolingDishes(db, clock);

  const plan = buildPool(db, {
    diners,
    month,
    recent,
    times30d,
    cooling,
    seasonalIngredients: seasonalIngredientIds(db, month),
  });
  if (plan.pool.length === 0) throw new NoCandidatesError(id);

  const structure = planStructure(diners, plan.pool);
  const promptInput = {
    slot: { date: parsed.date, meal: parsed.meal },
    structure,
    diners,
    pool: plan.pool,
    recentDishes: recent,
    // 近 30 天反馈摘要（点赞 + 带标签的反馈）：**软信号**进 prompt，零数值权重（ADR-0005）。
    // 点踩的**判定**不进摘要——它已经由冷藏期的硬排除表达完了；但**标签**进摘要（「为什么太油」
    // 是另一个问题，布尔的冷藏期答不了；界面上唯一能选标签的两条路都要有这个出口）。
    feedbackSummary: feedbackSummary(db, clock),
  };
  const prompt = buildPrompt(promptInput);

  const selection = await selectWithLlm(
    llm,
    prompt.system,
    prompt.prompt,
    plan.pool.map((entry) => ({ id: entry.id, kind: entry.kind })),
    structure,
  );

  const byId = new Map(plan.pool.map((entry) => [entry.id, entry]));
  const picked: RecommendedDish[] = selection.dishes.map((dish) => {
    const entry = byId.get(dish.recipeId)!;
    return {
      recipeId: entry.id,
      name: entry.name,
      kind: entry.kind,
      origin: entry.origin,
      reason: dish.reason,
    };
  });

  const notes = [...structureNotes(diners, structure), ...selection.notes];

  return {
    slotId: id,
    diners: diners.map((member) => ({ memberId: member.id, name: member.name, emoji: member.emoji })),
    structure,
    // 简化推荐：LLM 四次都没给出合法结果，由规则按位挑（理由 null，不编造）
    dishes: picked.length > 0 ? picked : simplifiedPick(plan.pool, structure),
    llm: selection.meta,
    notes,
  };
}

function resolveDiners(db: Db, ids: string[] | undefined): MemberProfile[] {
  // 不传名单 = 全体家人（与定餐编辑器的默认同一口径）
  if (ids === undefined) return listMembers(db);
  return resolveMembers(db, ids);
}

export interface PoolPlan {
  pool: PoolEntry[];
  /** 每位家庭池里留了几道（可观测：补位规则与结构收敛都以它为准） */
  familyCounts: Record<Position, number>;
  /** 每位补了几道外部菜 */
  externalCounts: Record<Position, number>;
}

/**
 * 规则检索（总纲 §4①）：
 *   忌口硬过滤（含隐性忌口展开，`recipe.avoidIngredientIds` 已经是展开后的并集）
 *   × 同菜 7 天硬排除 → 按位取家庭池（每位最多 8 道，时令/没做过/爱吃/快手 排序）
 *   → 某位家庭池 <3 时外部池补到 3（origin='external'，界面标「没做过」）。
 *
 * 顺序要紧：**硬排除在取池之前**，被排除的菜根本不进池子，也就没机会被 LLM 选走；
 * 而「近 7 天已吃」的全量另有段落进 prompt 作软避让（主料别连着重复）。
 * 冷藏期的菜（点踩的硬后果，ADR-0005）与忌口同一位置：入池前就排掉，不靠排序。
 */
export function buildPool(
  db: Db,
  context: {
    diners: MemberProfile[];
    month: number;
    /** 近 7 天上桌过的菜（硬排除） */
    recent: RecentDish[];
    /** 近 30 天做过几次（软信号，进 prompt） */
    times30d: Map<string, number>;
    /** 冷藏期内的菜（点踩的硬后果）：窗口内不进池，到期自动回来 */
    cooling: Map<string, string>;
    /** 当月时令的食材 id（排序用，不是过滤器） */
    seasonalIngredients: Set<string>;
  },
): PoolPlan {
  const avoid = new Set(context.diners.flatMap((member) => member.avoid.map((entry) => entry.ingredientId)));
  const recentIds = new Set(context.recent.map((dish) => dish.recipeId));
  const loves = new Set(context.diners.flatMap((member) => member.loves.map((entry) => entry.id)));

  const allowed = (recipe: Recipe): boolean =>
    !recentIds.has(recipe.id) &&
    !context.cooling.has(recipe.id) &&
    !recipe.avoidIngredientIds.some((ingredientId) => avoid.has(ingredientId));

  const rank = (recipes: Recipe[]): Recipe[] =>
    rankPool(recipes, {
      month: context.month,
      recentDishIds: recentIds,
      loves,
      seasonalIngredients: context.seasonalIngredients,
    });

  const family = rank(listRecipes(db, 'active').filter(allowed));
  // 外部池 = 草稿态菜谱（ADR-0006 状态机；不是另一张表，也不是另一套导入路）。
  // **含「待重标」项（0 克）的草稿不进池**：0 克是导入期的显式状态（迁移 005：模糊份量等
  // LLM 重标），不是「这道菜不要这个食材」。放它进池，份量引擎会直接乘出 0 g 进合计
  // （#16 的 `portion.ts` 只管算克数，菜谱侧的过滤归这里）。重标成功后写回正数，
  // 状态自然消失、草稿自动回到池里——不需要额外的白名单或人工解锁。
  const external = rank(listRecipes(db, 'draft').filter(allowed).filter((recipe) => !hasPendingRelabel(recipe)));

  const pool: PoolEntry[] = [];
  const familyCounts: Record<Position, number> = { meat: 0, veg: 0, soup: 0 };
  const externalCounts: Record<Position, number> = { meat: 0, veg: 0, soup: 0 };

  for (const position of POSITIONS) {
    const kept = family.filter((recipe) => positionOf(recipe.kind) === position).slice(0, MAX_FAMILY_PER_POSITION);
    familyCounts[position] = kept.length;
    pool.push(...kept.map((recipe) => poolEntryOf(recipe, 'family', context.times30d.get(recipe.id) ?? 0)));
    if (kept.length < MIN_FAMILY_PER_POSITION) {
      const padding = external
        .filter((recipe) => positionOf(recipe.kind) === position)
        .slice(0, MIN_FAMILY_PER_POSITION - kept.length);
      externalCounts[position] = padding.length;
      // 补位菜恒 0 次：「没做过」是它的定义，不是统计结果
      pool.push(...padding.map((recipe) => poolEntryOf(recipe, 'external', 0)));
    }
  }

  return { pool, familyCounts, externalCounts };
}

/**
 * 池子条目的紧凑形状（进 prompt 的那份，总纲 §4②：id/菜名/主料/位/近 30 天次数/来源）。
 * 主料取食材清单前 2 项并**剔掉调料**：糖醋里脊的主料是里脊，不是番茄酱——
 * 给 LLM 看调料只会增加「这道菜重样了」的误判。
 *
 * `poolEntryOf`（导出）：整餐推荐与换菜候选共用同一份形状——池子是同一个池子，
 * 两处各有一套「菜谱 → 池子条目」的转换就是等它们漂移。
 */
export function poolEntryOf(recipe: Recipe, origin: RecipeOrigin, times30d = 0): PoolEntry {
  return {
    id: recipe.id,
    name: recipe.name,
    kind: recipe.kind,
    mains: recipe.ingredients
      .filter((item) => !SEASONINGS.has(item.ingredientId))
      .slice(0, 2)
      .map((item) => item.name),
    origin,
    times30d,
  };
}

/**
 * 调料白名单：这些食材不进「主料」列（它们是做法的一部分，不是这餐吃什么）。
 * 用封闭小集合而不是「按克数阈值」：阈值会把虫草花 5g 这类 fixed 项误判成调料。
 *
 * 边界：**口尝可见的辛辣香料（辣椒、豆瓣酱、蒜、葱、姜）一律当调料**，不列主料。
 * 这会让「宫保鸡丁」的主料只剩鸡腿肉（辣椒确实是可吃的主料，但一一枚举会没完）——
 * 主料只用于展示，不影响结构、过滤与份量，所以取「宁可少列」这一边。
 */
const SEASONINGS = new Set([
  'salt',
  'sugar',
  'vinegar',
  'cooking_oil',
  'sesame_oil',
  'light_soy_sauce',
  'dark_soy_sauce',
  'cooking_wine',
  'starch',
  'oyster_sauce',
  'doubanjiang',
  'tomato_paste',
  'chili',
  'sichuan_pepper',
  'garlic',
  'ginger',
  'scallion',
]);

/**
 * 家规结构（总纲 §2.2）：基线 2 荤 1 素 1 汤，每 ±1 大人 ±1 道菜（加在荤位——人多通常多一个硬菜）。
 * 小孩不改变道数：他们吃的量由份量引擎按分带折算（ADR-0004），不是靠多炒一盘。
 *
 * 再按**池子实际能力**收敛：要求「荤 3」而荤位只剩 2 道，就是把 LLM 放进一个无解的任务
 * （strict 档必然结构校验失败）。收敛后的结构写进 prompt 与响应，缺额由 `structureNotes` 说明。
 */
export function planStructure(diners: MemberProfile[], pool: PoolEntry[]): RecommendationStructure {
  const desired = desiredStructure(diners);
  const available = availabilityOf(pool);
  return {
    adults: desired.adults,
    children: desired.children,
    meat: Math.min(desired.meat, available.meat),
    veg: Math.min(desired.veg, available.veg),
    soup: Math.min(desired.soup, available.soup),
  };
}

/** 家规公式要的道数（未按池子收敛的「应该配多少」） */
function desiredStructure(diners: MemberProfile[]): RecommendationStructure {
  const adults = diners.filter((member) => member.kind === 'adult').length;
  const children = diners.filter((member) => member.kind === 'child').length;
  // 大人数如实报（prompt 里的「大人 0、小孩 2」与结构不能各说各的）。
  // 道数另有下限：没人吃就不定餐了，但一份菜单至少要有一道能配上——所以料位不低于 1。
  return {
    adults,
    children,
    meat: Math.max(1, BASELINE.meat + (adults - BASELINE_ADULTS)),
    veg: BASELINE.veg,
    soup: BASELINE.soup,
  };
}

/** 池子实际能撑起多少道（每位数一遍） */
function availabilityOf(pool: PoolEntry[]): Record<Position, number> {
  const available: Record<Position, number> = { meat: 0, veg: 0, soup: 0 };
  for (const entry of pool) available[positionOf(entry.kind)] += 1;
  return available;
}

/** 结构被池子收敛时说明缺在哪位（家人看到的不是「怎么少了一个菜」而是原因） */
function structureNotes(diners: MemberProfile[], structure: RecommendationStructure): string[] {
  const desired = desiredStructure(diners);
  const notes: string[] = [];
  if (structure.meat < desired.meat) notes.push(`荤菜候选不够，本餐配了 ${structure.meat} 道荤菜。`);
  if (structure.veg < desired.veg) notes.push(`素菜候选不够，本餐配了 ${structure.veg} 道素菜。`);
  if (structure.soup < desired.soup) notes.push('汤位候选不够，本餐没配汤。');
  return notes;
}

interface LlmSelection {
  dishes: SelectionDish[];
  meta: MealRecommendation['llm'];
  notes: string[];
}

/**
 * 整餐推荐的降级链（总纲 §4、spec S7）：strict `json_schema` 试 2 次 → `json_object` + Zod 试 2 次
 * → 简化推荐（返回空挑选，由调用方按规则拼）。
 *
 * 「试 2 次」把两种失败一视同仁：网络/超时（换一次可能就好）与形状/结构不合（模型这次没听话）
 * 都值得再给一次机会；两次都不行就换档。**每次失败都记一条 note**——家人要能看见
 * 「这次为什么是简化推荐」，而不是只看到一个标记。
 *
 * 链本身在 `llm/selection-chain.ts`（与换菜候选共用），这里只包上整餐特有的文案与校验。
 */
async function selectWithLlm(
  llm: LlmClient,
  system: string,
  prompt: string,
  pool: { id: string; kind: RecipeKind }[],
  structure: RecommendationStructure,
): Promise<LlmSelection> {
  const result = await runSelectionChain({
    llm,
    system,
    prompt,
    jsonSchema: RECOMMENDATION_JSON_SCHEMA,
    promptVersion: PROMPT_VERSION,
    jsonObjectNote: '端点未支持严格 schema，本餐改用 JSON 格式档完成。',
    fallbackNote: 'LLM 两次都没能给出合法结果，本餐由规则直接拼出（简化推荐）。',
    check: (text) => {
      const outcome = checkSelection(text, pool, structure);
      return outcome.ok ? { ok: true, value: outcome.dishes } : { ok: false, reason: outcome.reason };
    },
  });
  return { dishes: result.value ?? [], meta: result.meta, notes: result.notes };
}

/**
 * 简化推荐（CONTEXT「简化推荐」）：按 `plan.pool` 已排好的序（时令 → 没做过 → 爱吃 → 快手）
 * 逐位取满结构。**理由为 null**——没有 LLM 参与的时刻，界面上编一句「为什么推这道」是撒谎。
 */
function simplifiedPick(pool: PoolEntry[], structure: RecommendationStructure): RecommendedDish[] {
  const want: Record<Position, number> = { meat: structure.meat, veg: structure.veg, soup: structure.soup };
  const taken: Record<Position, number> = { meat: 0, veg: 0, soup: 0 };
  const dishes: RecommendedDish[] = [];
  for (const entry of pool) {
    const position = positionOf(entry.kind);
    if (taken[position] >= want[position]) continue;
    taken[position] += 1;
    dishes.push({ recipeId: entry.id, name: entry.name, kind: entry.kind, origin: entry.origin, reason: null });
  }
  return dishes;
}
