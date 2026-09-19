import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import type { LlmClient } from '../llm/types.js';
import { buildCandidatePrompt, CANDIDATE_PROMPT_VERSION, rankPool, type PoolEntry } from '../llm/prompt.js';
import { checkCandidates, CANDIDATE_JSON_SCHEMA, MAX_CANDIDATES, positionOf } from '../llm/recommendation-schema.js';
import { runSelectionChain } from '../llm/selection-chain.js';
import type {
  MealSlot,
  MemberProfile,
  Recipe,
  SwapCandidate,
  SwapCandidates,
  SwapExcluded,
  SwapRelaxation,
} from '../wire-types.js';
import { ingredientLabel, seasonalIngredientIds } from './ingredients.js';
import { coolingDishes, feedbackSummary } from './feedback.js';
import { listMembers, resolveMembers } from './members.js';
import { hasPendingRelabel, findRecipe, listRecipes } from './recipes.js';
import { DEDUPE_DAYS, MAX_FAMILY_PER_POSITION, MIN_FAMILY_PER_POSITION, poolEntryOf } from './recommendation.js';
import { parseDate } from './family-time.js';
import {
  foldSlot,
  hasMealPassed,
  InvalidSlotIdError,
  parseSlotId,
  recentDishes,
  SlotPassedError,
} from './slots.js';

/**
 * 换菜候选管线（总纲 §2.3、§4）：已定菜单里下钻换掉**单道**，一次给 3 个候选、各带一句理由。
 *
 * 与整餐推荐的分工完全同构（ADR-0001）：忌口硬过滤、同位筛选、去重排序全部前置，
 * LLM 只做「从同位池里挑 3 个 + 各写一句理由」，输出只是菜谱 id。
 *
 * 三件换菜特有的事：
 *
 * 1. **同位**：候选只能与原菜同荤素位（`soup_meat`/`soup_veg` 同属汤位）。替换一个荤菜
 *    却端上一道汤，等于把家规结构偷偷改了——那该走「加菜/换一整套」，不是单道替换。
 * 2. **会话内累积排除**：调用方把本会话累积排除的菜（被换掉的 + 已出示过的候选）回传，池子还够就不重复出现。
 *    「再换一个」的意思就是「刚才那几个我不要」，所以这是**软排除**：池子干到凑不出一个候选时
 *    按层放宽（先去重窗口、再会话排除），并把放宽的事实在 `relaxed` 里报出来。
 *    忌口**永不放宽**——它不是「挑食」，是安全问题。
 * 3. **忌口排除原因**：被硬过滤掉的同位菜要连原因一起给（「白灼虾 — 小宝忌虾」）。
 *    spec §2.3 明说要展示它：看不见的排除会让人以为库里没有这道菜。
 *
 * 不落库、不缓存（与整餐推荐同一取舍）：候选是「点一下现算」的一次性结果，
 * 接受与否由用户的下一次 `PUT /api/slots/:id`（souce='manual' 的改餐）决定。
 */

export interface CandidateOptions {
  /** 这餐谁吃；不传 = 已定菜单的用餐者快照 */
  diners?: string[];
  /**
   * 当前菜单（recipe id，按界面顺序）。**未定餐槽必须给**：编辑器里的草稿菜单还没落库，
   * 服务端没有别的办法知道被换的那道菜在不在菜单里（总纲 §2.1 定餐 = 换菜，同一编辑器）。
   */
  dishes?: string[];
  /** 本次会话已出示过的候选（软排除；spec §2.3 的累积排除还包括被换掉的那道菜） */
  exclude?: string[];
}

/** 这餐还没定，且调用方没把草稿菜单带上来——没有菜单就没有可换的菜 */
export class SlotUndecidedError extends Error {
  constructor(readonly id: string) {
    super(`这一餐还没有定，也没有传草稿菜单：${id}`);
    this.name = 'SlotUndecidedError';
  }
}

/** 要换的那道菜不在这一餐的菜单里（界面与服务端的菜单漂移了） */
export class DishNotInMenuError extends Error {
  constructor(readonly recipeId: string) {
    super(`这一餐的菜单里没有这道菜：${recipeId}`);
    this.name = 'DishNotInMenuError';
  }
}

/** 换一道菜，连一个候选都凑不出来（忌口 + 同位 + 菜单已占全排完了） */
export class NoCandidatesError extends Error {
  constructor(readonly recipeId: string) {
    super('这个位子上没有别的菜可换了：换个用餐者名单，或过几天再试。');
    this.name = 'NoCandidatesError';
  }
}

export async function findCandidates(
  db: Db,
  clock: Clock,
  llm: LlmClient,
  id: string,
  replacingId: string,
  options: CandidateOptions = {},
): Promise<SwapCandidates> {
  const parsed = parseSlotId(id);
  if (!parsed) throw new InvalidSlotIdError(id);
  if (hasMealPassed(db, clock, parsed.date, parsed.meal)) throw new SlotPassedError(id);

  const slot = foldSlot(db, clock, parsed.date, parsed.meal);
  const menu = menuOf(slot, options);
  if (!menu.has(replacingId)) throw new DishNotInMenuError(replacingId);

  // 走菜谱读取口（domain/recipes.ts）而不是裸 SQL：忌口推导、荤素位口径都归它一处维护
  const recipe = findRecipe(db, replacingId);
  if (!recipe) throw new DishNotInMenuError(replacingId);
  // 线上形状用 `recipeId`（wire-types 的 SwapCandidates.replacing），领域内部沿用菜谱行
  const replacing = { recipeId: recipe.id, name: recipe.name, kind: recipe.kind };

  const diners = resolveDiners(db, slot, options);
  const month = parseDate(parsed.date)!.month;
  const recent = recentDishes(db, clock, DEDUPE_DAYS);
  const times30d = new Map(recentDishes(db, clock, 30).map((dish) => [dish.recipeId, dish.times]));
  const exclude = new Set(options.exclude ?? []);
  // 冷藏期是**硬排除**（ADR-0005）：点踩过的菜在窗口内不进候选，且不放宽——
  // 与忌口不同（那是安全问题），但它同样是「这条路上不要再出现这道菜」的硬规则，
  // 池干时唯一该发生的是「没得换」，而不是把家人刚说过不要的菜端回来。
  const cooling = coolingDishes(db, clock);

  const layer = buildCandidatePool(db, {
    diners,
    month,
    recent,
    times30d,
    exclude,
    cooling,
    replacing,
    menu,
    seasonalIngredients: seasonalIngredientIds(db, month),
  });
  if (layer.pool.length === 0) throw new NoCandidatesError(replacingId);

  const promptInput = {
    slot: { date: parsed.date, meal: parsed.meal },
    replacing,
    count: Math.min(MAX_CANDIDATES, layer.pool.length),
    diners,
    pool: layer.pool,
    recentDishes: recent,
    // 近 30 天反馈摘要：**软信号**进 prompt（ADR-0005 的另一条路，与冷藏期的硬排除分开）
    feedbackSummary: feedbackSummary(db, clock),
  };
  const prompt = buildCandidatePrompt(promptInput);

  const selection = await runSelectionChain({
    llm,
    system: prompt.system,
    prompt: prompt.prompt,
    jsonSchema: CANDIDATE_JSON_SCHEMA,
    promptVersion: CANDIDATE_PROMPT_VERSION,
    jsonObjectNote: '端点未支持严格 schema，这次换菜改用 JSON 格式档完成。',
    fallbackNote: 'LLM 两次都没能给出合法结果，这几个候选由规则排序直接给（时令 + 没做过 + 爱吃 + 快手）。',
    check: (text) => {
      const outcome = checkCandidates(text, layer.pool);
      return outcome.ok ? { ok: true, value: outcome.candidates } : { ok: false, reason: outcome.reason };
    },
  });

  const byId = new Map(layer.pool.map((entry) => [entry.id, entry]));
  const candidates: SwapCandidate[] =
    selection.value === undefined
      ? ruleCandidates(layer.pool)
      : selection.value.map((candidate) => toCandidate(byId.get(candidate.recipeId)!, candidate.reason));

  const notes = [...layer.notes, ...selection.notes];
  return {
    slotId: id,
    replacing,
    candidates,
    excluded: layer.excluded,
    relaxed: layer.relaxed,
    llm: selection.meta,
    notes,
  };
}

/**
 * 会话排除 / 去重窗口两层软排除的**分层放宽**（spec §2.3：池干后放宽）——只由 `findCandidates` 调。
 *
 * 档位从严格到松：A 严格（近 7 天做过的 + 本会话排除掉的都不要） → B 放回去重窗口
 * （「实在没别的了，就推荐刚吃过的」）→ C 再放回会话排除掉的（「这一轮转回来了」）。
 * 「放宽」不是失败：它是把「没得选」变成「有几个不那么理想的」，所以档位要在响应里报出来，
 * 界面据此提示家人（比如「这几道刚吃过」）。
 *
 * 一直不放宽的两条：**忌口**（硬过滤，安全问题）与**同桌已占用的菜**（再做一道一模一样的没意义）。
 * 冷藏期是入池前就排掉的（同一份 `samePosition` 就不再出现），所以放宽对它也不生效。
 */
function buildCandidatePool(
  db: Db,
  context: {
    diners: MemberProfile[];
    month: number;
    recent: { recipeId: string }[];
    times30d: Map<string, number>;
    exclude: Set<string>;
    /** 冷藏期内的菜（点踩的硬后果）：窗口内不进候选，任何放宽档都不放回 */
    cooling: Map<string, string>;
    replacing: { recipeId: string; name: string; kind: Recipe['kind'] };
    /** 本餐菜单上已有的菜（含被换掉的那道）：它们不该作为候选再上一遍 */
    menu: Set<string>;
    seasonalIngredients: Set<string>;
  },
): { pool: PoolEntry[]; excluded: SwapExcluded[]; relaxed: SwapRelaxation; notes: string[] } {
  const avoid = new Map<string, string[]>();
  for (const member of context.diners) {
    for (const entry of member.avoid) {
      const list = avoid.get(entry.ingredientId);
      if (list) list.push(member.name);
      else avoid.set(entry.ingredientId, [member.name]);
    }
  }
  const loves = new Set(context.diners.flatMap((member) => member.loves.map((entry) => entry.id)));
  const recentIds = new Set(context.recent.map((dish) => dish.recipeId));
  const position = positionOf(context.replacing.kind);

  /** 本餐的忌口命中：菜谱的忌口食材并集 ∩ 用餐者忌口；空数组 = 能吃 */
  const blockersOf = (recipe: Recipe): string[] => {
    const hits: string[] = [];
    for (const ingredientId of recipe.avoidIngredientIds) {
      const members = avoid.get(ingredientId);
      if (!members) continue;
      for (const member of members) {
        const name = ingredientLabel(db, ingredientId);
        hits.push(`${member}忌${name}`);
      }
    }
    return [...new Set(hits)];
  };

  // 候选与「为什么没选它」都从同一个同位集合里分出来：同位且没被忌口命中的能当候选，
  // 命中的进 excluded 带原因展示——被排除的菜也要看得见，否则家人以为库里没有这道菜。
  // 同桌已有的菜（含正在被换掉的那道）不进 excluded：那是「已经在桌上了」，不是「被忌口排除」。
  const samePosition = [...listRecipes(db, 'all')].filter(
    (recipe) => recipe.status !== 'retired' && positionOf(recipe.kind) === position && !context.cooling.has(recipe.id),
  );
  const excluded: SwapExcluded[] = [];
  const eligible: Recipe[] = [];
  for (const recipe of samePosition) {
    if (recipe.id === context.replacing.recipeId || context.menu.has(recipe.id)) continue;
    const blockers = blockersOf(recipe);
    if (blockers.length > 0) {
      excluded.push({ recipeId: recipe.id, name: recipe.name, reason: blockers.join('、') });
      continue;
    }
    // 含「待重标」项（0 克）的**草稿**不进候选——与整餐推荐同一道口子（`hasPendingRelabel`）。
    // 0 克是导入期的显式状态（迁移 005），它乘进份量就是 0 g；重标成功后状态自然消失。
    // 家庭菜谱不过这道口子（与整餐推荐的 family 池同口径）：克数是掌勺者确认过的，
    // 0 克只可能是异常数据，不该由这里静默影响换菜。
    // 它与「被忌口排除的」不同：不是「不能吃」，而是「克数还没定」，所以不进 `excluded` 清单
    // （那份清单是给家人看的忌口排除原因）。
    if (recipe.status === 'draft' && hasPendingRelabel(recipe)) continue;
    eligible.push(recipe);
  }

  const rank = (recipes: Recipe[]): Recipe[] =>
    rankPool(recipes, {
      month: context.month,
      recentDishIds: recentIds,
      loves,
      seasonalIngredients: context.seasonalIngredients,
    });

  // 池子的三层（spec §2.3：同一换菜会话内累积排除，**池干后放宽**）：
  // A 严格 → B 放回近 7 天做过的 → C 再放回本会话排除掉的。选「第一个非空的层」——
  // 只要还有一道从没出现过的菜，就不该把刚吃过的端上来；一层都空才说明真的没得换。
  // 两个例外不接受任何放宽：忌口（已在上面硬过滤）与同桌已占用的菜。
  const tiers: { relaxed: SwapRelaxation; recipes: Recipe[] }[] = [
    { relaxed: 'none', recipes: eligible.filter((recipe) => !recentIds.has(recipe.id) && !context.exclude.has(recipe.id)) },
    { relaxed: 'dedupe', recipes: eligible.filter((recipe) => !context.exclude.has(recipe.id)) },
    { relaxed: 'session', recipes: eligible },
  ];
  const tier = tiers.find((candidate) => candidate.recipes.length > 0) ?? { relaxed: 'none' as SwapRelaxation, recipes: [] };

  // 家庭池每位最多 8 道（与整餐推荐同一上限）；同位菜不够 3 道时用外部池补到 3（spec S6）
  const ranked = rank(tier.recipes.filter((recipe) => recipe.status === 'active'));
  const pool: PoolEntry[] = ranked.slice(0, MAX_FAMILY_PER_POSITION).map((recipe) => poolEntryOf(recipe, 'family', context.times30d.get(recipe.id) ?? 0));
  if (pool.length < MIN_FAMILY_PER_POSITION) {
    const padding = tier.recipes
      .filter((recipe) => recipe.status === 'draft')
      .slice(0, MIN_FAMILY_PER_POSITION - pool.length);
    // 补位菜恒 0 次：「没做过」是它的定义，不是统计结果
    pool.push(...padding.map((recipe) => poolEntryOf(recipe, 'external', 0)));
  }

  const notes: string[] = [];
  const relaxedNote = relaxationNote(tier.relaxed);
  if (relaxedNote) notes.push(relaxedNote);

  return { pool, excluded, relaxed: tier.relaxed, notes };
}

/**
 * 分层放宽的说明：池子被放宽到哪一层是**要不要告诉家人**的信息（「这几道刚吃过」与
 * 「这几道刚才已经出示过」是两种不同的处境），所以 note 按层给，而不是笼统一句「放宽了」。
 */
function relaxationNote(relaxed: SwapRelaxation): string | undefined {
  if (relaxed === 'dedupe') return '同位候选不多了：这几道里有近 7 天刚做过的。';
  if (relaxed === 'session') return '同位候选快用完了：这几道刚才已经出示过。';
  return undefined;
}

/** 规则排序 top3（spec §2.3：LLM 失败降级为规则排序 top3）：池子已经排好序，取前 3 即可 */
function ruleCandidates(pool: PoolEntry[]): SwapCandidate[] {
  return pool.slice(0, MAX_CANDIDATES).map((entry) => toCandidate(entry, null));
}

function toCandidate(entry: PoolEntry, reason: string | null): SwapCandidate {
  return { recipeId: entry.id, name: entry.name, kind: entry.kind, origin: entry.origin, reason };
}

/**
 * 这一餐当前的菜单（recipe id 集合）。
 *
 * 两条来路：① 客户端带上来的**草稿菜单**（编辑器里改到一半的那份，总纲 §2.1 定餐 = 换菜）；
 * ② 已定餐槽的**服务端快照**（没人带草稿时）。两边都没有 = 没有菜单可换（未定且没草稿）。
 */
function menuOf(slot: MealSlot, options: CandidateOptions): Set<string> {
  if (options.dishes !== undefined) return new Set(options.dishes);
  if (!slot.menu) throw new SlotUndecidedError(slot.id);
  return new Set(slot.menu.dishes.map((dish) => dish.recipeId));
}

/**
 * 这餐谁吃（忌口与软加分的基数）。
 *
 * 三条来路，优先级从高到低：① 请求显式给的名单（编辑器里改到一半的名单）；
 * ② 已定菜单的**用餐者快照**（没显式给名单时就是这一餐当时定的那几个人）；③ 全体家人。
 *
 * ①用 `missing:'throw'`（显式名单里有人不存在就是调用方给错了）、②用 `missing:'skip'`
 * （成员已删就跳过，见 `resolveMembers` 的说明），两条语义分开表达而不是混在一个分支里。
 */
function resolveDiners(db: Db, slot: MealSlot, options: CandidateOptions): MemberProfile[] {
  if (options.diners !== undefined) return resolveMembers(db, options.diners);
  if (!slot.menu) return listMembers(db);
  return resolveMembers(db, slot.menu.diners.map((diner) => diner.memberId), { missing: 'skip' });
}
