import { writeFileSync } from 'node:fs';
import type { Db } from '../db/index.js';
import { classifyCuisines, relabelPortions, type RelabelRequest } from '../llm/import-schema.js';

// 导入期的 LLM seam：本模块的调用方（CLI、测试）不必再 import 一层 llm 目录
export { classifyCuisines, relabelPortions };
import type { LlmClient } from '../llm/types.js';
import type { RecipeCuisine, RecipeKind, RecipeSource, TasteTag } from '../wire-types.js';

/**
 * 冷启动导入管线的**落库侧**（总纲 §2.8、§5；ADR-0006）：外部菜谱池从近零到可用的唯一入口。
 *
 * **三条来源共用这一条管线**（ADR-0006：HowToCook / 下厨房爬取 / LLM 生成都是「素材层」）。
 * 管线依次是四步：
 *
 *   1. **采集器**（`library/collectors.ts`）把外部数据源读成 `DraftRecipe[]`——纯函数、不碰库；
 *   2. **清洗**（本文件 `isNoiseIngredientName` / `splitCombinedIngredientName`）把数据源那侧的
 *      **解析杂讯**（份量表达式「盐量 = 份数」、分段小标题、厨具、说明片段）整项丢掉，
 *      把**连写名**（「姜蒜」「葱、姜、蒜共」）拆成两条——两件都发生在归一**之前**，是纯函数；
 *   3. **归一**（本文件 `normalizeRecipe`）把采集到的食材名对到食材字典的规范名上，对不上的记进
 *      报告（不静默丢、不新建字典行——字典是全库唯一受控表，见 `library/collectors.ts` 的采集口径）；
 *   4. **落库**（本文件 `importDrafts`）写成 `recipes.status='draft'`（外部池的存储形态，
 *      见迁移 004 的文件头）+ 食材项 + 口味 + 时令月份 + 菜系 tag。
 *
 * **来源字段如实**（spec 的 AC）：`recipe.source` 是采集器的来源，管线不改写——
 * 下厨房来的就是 `scraped`、HowToCook 来的就是 `howtocook`、LLM 生成的就是 `llm`。
 * 报告的每一条也都带着来源，于是「这批草稿是从哪来的」在报告里可查。
 *
 * **份量重标**（spec §2.8「模糊份量（「适量」）导入/转正时一律由 LLM 重标到成人份克数」）：
 * 重标的路在 `llm/import-schema.ts` 的 `relabelPortions`，本文件只消费它的产出
 * （`RelabelOutcome` 的 `assignments`），把「这道菜有多少项重标过 / 哪些还是估的」记进报告。
 * **覆盖率可见**是 AC 的明文要求。
 */

// ---------------------------------------------------------------- 采集侧的形状（进这条管线的原料）

/** 一条采集到的、**还没归一**的食材项：名字来自外部数据源原文 */
export interface RawIngredient {
  /** 原文名字（「猪五花肉」「青尖椒」这种，还没对到字典规范名） */
  name: string;
  /**
   * 成人份克数，`null` = 原文是「适量/少许/若干」这类模糊份量，**必须**由 LLM 重标。
   * 注意这不等于「没克数」：`quantity` 原文（「3 瓣」）会留在报告里给 LLM 当上下文。
   */
  adultGrams: number | null;
  /** 原文里的份量文本（「约 3~4 斤」「两勺」「适量」），重标的输入与报告的证据 */
  quantity: string;
  /** 采集器对这个食材项的缩放规则判断：调料/香料一锅就这么多 → fixed */
  scaling: 'linear' | 'fixed';
}

/** 采集器读到的一道菜（纯数据，不含任何数据库概念） */
export interface DraftRecipe {
  /** 稳定 id（采集器生成：来源前缀 + 菜名 slug），落库主键 */
  id: string;
  name: string;
  aliases: string[];
  kind: RecipeKind;
  effort: 'quick' | 'medium' | 'heavy';
  source: RecipeSource;
  /** 采集时的原始口径（HowToCook 的目录、下厨房的页面 URL），报告里留着可回溯 */
  sourceRef: string;
  /** 口味五标签（采集器按菜名/食材给初值，LLM 缺失时它就是最终值） */
  tastes: TasteTag[];
  /** 时令月份（可空：空 = 四季皆宜） */
  seasonMonths: number[];
  /** 菜系参考 tag（导入时 LLM 初打；采集器能给确定值时才填） */
  cuisine: RecipeCuisine | null;
  steps: string;
  ingredients: RawIngredient[];
}

// ---------------------------------------------------------------- 报告（AC：导入量、重标量、归一失败清单）

/** 一道菜落库后的结果：成功了就带 id，失败了带原因（**失败不落地**，整条进报告） */
export interface ImportedRecipe {
  id: string;
  name: string;
  source: RecipeSource;
  sourceRef: string;
  /** 归一成功的食材项数 */
  ingredients: number;
  /** 其中由 LLM 重标过克数的项数 */
  relabeled: number;
}

export interface RejectedRecipe {
  id: string;
  name: string;
  source: RecipeSource;
  sourceRef: string;
  reason: string;
}

/** 归一失败的一条：**不静默丢**（AC 明文要求「归一失败清单」） */
export interface UnmatchedIngredient {
  /** 采集原文里的名字（就是它没对上字典） */
  name: string;
  /** 哪几道菜里有它（按菜名，报告给人看） */
  dishes: string[];
  /** 出现次数（同一名字可能出现在多道菜里） */
  occurrences: number;
}

/**
 * 解析杂讯的一条（issue #28：44 条「盐量 = 份数」类）。
 *
 * 它与 `UnmatchedIngredient` 分开列，理由是这个分栏**决定下一步动作**：
 * 归一失败要去补字典/别名，而杂讯去补字典是白费（research §10 的四分类）——
 * 要改的是采集解析。混在一起会让人按「出现次数最多」去补一条不该存在的字典行。
 */
export interface DroppedNoise {
  /** 采集原文里的名字 */
  name: string;
  /** 哪几道菜里出现了它 */
  dishes: string[];
  occurrences: number;
}

/** 份量重标的可见结果（AC：「模糊份量重标为成人份克数，重标覆盖率可见」） */
export interface RelabelReport {
  /** 全库草稿里需要重标的食材项（`adult_grams` 来源是模糊份量）总数 */
  needed: number;
  /** 已经被 LLM 重标过的项数 */
  done: number;
  /** 覆盖率（done / needed，needed 为 0 时记 1——没有需要重标的就没有欠账） */
  coverage: number;
  /** 还没重标的项，按食材名列（界面/报告要能说清「还差哪些」） */
  pending: { recipeId: string; recipeName: string; ingredient: string; quantity: string }[];
}

export interface ImportReport {
  /** 本次运行的时间戳（报告文件的内容包含它；同一批数据两次导入会得到两个文件） */
  generatedAt: string;
  /** 本次提交里成功落库的草稿（按来源分） */
  imported: ImportedRecipe[];
  /** 被拒的（归一失败、身份冲突、采集器判定的不适格……）：**没有半截落库** */
  rejected: RejectedRecipe[];
  /** 归一失败清单（跨全库：含本次被拒的与历史导入里留下的） */
  unmatched: UnmatchedIngredient[];
  /**
   * 被当作解析杂讯丢掉的项（本票新增）。**丢归丢，看得见**——不静默丢是本票的纪律，
   * 而「丢了多少」与「为什么丢」是 review 这批清洗规则的唯一凭据。
   */
  dropped: DroppedNoise[];
  /** 重标覆盖率（跨全库草稿，不只本次） */
  relabel: RelabelReport;
  /** 备注（例如「dry-run：只算不写」、来源不可达时的降级说明） */
  notes: string[];
}

// ---------------------------------------------------------------- 归一

/** 字典快照：导入是**离线批处理**，一次把字典读进内存再比对，不逐条查库 */
export interface IngredientIndex {
  /** 名字（规范名 + 别名）→ 食材 id。**别名全局唯一**（001/002/005 的纪律）所以这张表无歧义 */
  byName: Map<string, string>;
  /** 食材 id → 规范名（报告里说人话） */
  nameOf: Map<string, string>;
  /** 食材 id → 直接「含」指针（隐性忌口，报告与归一提示用） */
  contains: Map<string, string[]>;
}

export function loadIngredientIndex(db: Db): IngredientIndex {
  const byName = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const row of db.prepare('SELECT id, name FROM ingredients').all() as { id: string; name: string }[]) {
    nameOf.set(row.id, row.name);
    byName.set(row.name, row.id);
  }
  for (const row of db
    .prepare('SELECT ingredient_id, alias FROM ingredient_aliases')
    .all() as { ingredient_id: string; alias: string }[]) {
    byName.set(row.alias, row.ingredient_id);
  }

  const contains = new Map<string, string[]>();
  for (const row of db
    .prepare('SELECT ingredient_id, contains_id FROM ingredient_contains')
    .all() as { ingredient_id: string; contains_id: string }[]) {
    const list = contains.get(row.ingredient_id);
    if (list) list.push(row.contains_id);
    else contains.set(row.ingredient_id, [row.contains_id]);
  }
  return { byName, nameOf, contains };
}

/**
 * 解析杂讯的形状（issue #28 的四分类之一：「盐量 = 份数」类）。
 *
 * 这一组是**整项丢掉**的：它们整条都不是食材名，而是外部数据源的排版被采集器当成了食材行——
 * 段落小标题（「酱汁部分」「方法一」「其他调料」）、厨具（「不粘锅」「蒸锅用水」）、
 * 说明片段（「单人，约」「无骨肉共需」「菜码 总量」）。
 *
 * 与它成对的是 `cleanName` 里的**份量表达式尾巴**：「盐量 = 份数」「牛肉用量为」这类名字里
 * **前面那一截是真食材**，不能整项丢掉（丢了就是故事 1 的「买菜清单缺项」），
 * 所以那一路是剥掉尾巴留下「盐」「牛肉」。只有剥完仍然什么都不剩的（「量 = 份数」）才丢。
 *
 * 为什么在**导入管线**清洗而不是补字典：research §10 的四分类结论是「补字典没用」——
 * 给「酱汁部分」建一条字典行，受控食材表就被污染了（story 5），而那条行永远不会被任何菜谱
 * 合理地用到。为什么不在采集器里清洗：数据源快照（`library-data/*.jsonl`）是**既成文件**，
 * 改采集器救不了已经落盘的快照——清洗得发生在读快照之后的管线上。
 */
const NOISE_NAME_PATTERNS: RegExp[] = [
  // 分段/部分小标题：`酱汁部分`、`米饭部分`、`腌鸡部分`、`组装部分`
  /部分$/,
  // 段落标题本身（`方法一`、`其他调料`、`香料包`、`调`、`一般`）
  /^(主料|调料|香料包|调|一般|方法[一二三四五六七八九十]|其他调料|风味调料|蘸料|卤料|卤料包)$/,
  // 厨具：`不粘锅`、`铁锅`、`蒸锅用水`、`煲汤盅，按`
  /(不粘锅|铁锅|蒸锅|砂锅|高压锅|电饭煲|烤箱|空气炸锅|砧板|锅铲|煲汤盅)/,
  // 说明片段：`单人，约`、`单人，能支撑`、`无骨肉共需`、`菜码 总量`、`鱼 建议新手以`、`河粉料可按`、
  // `油的质量 Mo`（整句描述）。`总量`/`共需` 前后可能带空格（`菜码 总量`），所以不锚边界。
  /(单人|能支撑|共需|总量|按自己喜好|建议新手|依次累加|分别为|的质量|可按$)/,
  // 以「的」结尾：中文食材名不会以助词「的」结尾，这是**描述句被截断**的痕迹
  // （`水的体积是米饭的体积的`）。不挡住它的话，包含匹配会在那串字里认出「米饭」——
  // 于是「米粥」这道菜的**唯一食材**变成了一句描述，落库成一道只有一样东西的空壳菜。
  // 字典里没有任何以「的」结尾的名字（`schema-013.test.ts` 有断言），所以这条只杀杂讯。
  /的$/,
  // 整条就是一个单位/份量词（剥完尾巴什么都不剩的那种：`量 = 份数`）
  /^(量|数量|用量|份数)$/,
];

/** 这一条原文名字是不是解析杂讯（整项丢掉，且**不进归一失败清单**） */
export function isNoiseIngredientName(rawName: string): boolean {
  const cleaned = cleanName(rawName);
  if (cleaned === '') return true;
  // 同时拿**剥尾巴前后**两个名字去匹配：`菜码 总量` 的 `总量` 会被份量尾巴剥成 `总`，
  // 只看剥后的名字就漏判了；而 `酱汁部分` 这类剥不剥都一样。两个都判，取并集。
  const stripped = stripQuantityTail(cleaned);
  if (stripped === '') return true;
  return NOISE_NAME_PATTERNS.some((pattern) => pattern.test(cleaned) || pattern.test(stripped));
}

/** 连写名里的分隔符：`盐、糖`、`青葱，葱白`、`玉米粒和青豆` */
const NAME_SEPARATORS = /[、，,和]/;

/**
 * 连写名拆成多条食材名（story 6：「姜蒜」连写拆成两条，两个食材的克数都不丢）。
 *
 * 数据源里真出现过的形状：`姜蒜`、`葱姜蒜`、`葱、姜、蒜共`、`葱姜水`、`盐、糖`、`玉米粒和青豆总共`。
 * **别名救不了它们**——字典的别名是「一个叫法指向一个食材」（别名全局唯一），而这里一条名字里
 * 有两个食材（`library.ts` 文件头与 001 的注释都写着这条纪律），所以只能拆。
 *
 * 三条保守边界（与 `normalizeIngredientName` 的「宁可少认」同一纪律）：
 *   * **整串精确命中字典的不拆**：`蒜蓉辣酱`（自己的条目）能切成「蒜蓉 + 辣酱」两个真食材，
 *     但它是字典里的一条，拆了就错；
 *   * **拆出来的每一段都要归得上字典，且至少两个不同食材**：`青葱，葱白` 两段都指向「葱」，
 *     拆了会把 25g 变成 12.5g；`黑鳕鱼，带皮` 第一段就归不上——这两种都原样交回既有归一
 *     （含「包含匹配」）处理；
 *   * 拆不出来就返回一条（原样），**不制造新的归一失败项**。
 *
 * 克数是**合计量**（「姜蒜 50g」= 姜与蒜合计 50g），所以调用方拆分时要均分（见 `normalizeRecipe`）。
 */
export function splitCombinedIngredientName(index: IngredientIndex, rawName: string): string[] {
  const cleaned = stripQuantityTail(cleanName(rawName));
  if (cleaned === '' || index.byName.has(cleaned)) return [rawName];
  // 「A 或 B」与「A / B」不是连写（那是「两个都要」）：名字里含分隔符就不拆，
  // 原样交回 `normalizeIngredientName`（它的包含匹配已经能认出 `五花肉/瘦肉` 里的五花肉）
  if (/或者|或|\//.test(cleaned)) return [rawName];

  // ① 分隔符路径：`盐、糖`、`葱、姜、蒜`（`共`/`各`/`总共` 这类尾巴已在 cleanName 里剥掉）
  const parts = cleaned.split(NAME_SEPARATORS).filter((part) => part !== '');
  if (parts.length >= 2 && isDistinctIngredients(index, parts)) return parts;

  // ② 连写路径：`姜蒜`、`葱姜蒜`、`葱姜水`——整串刚好由若干个字典名拼成
  const segmented = segmentByIngredientNames(index, cleaned);
  if (segmented && isDistinctIngredients(index, segmented)) return segmented;

  return [rawName];
}

/** 这几段是不是「都归得上字典 ∧ 至少两个不同的食材」（拆分值不值得做的唯一判据） */
function isDistinctIngredients(index: IngredientIndex, parts: string[]): boolean {
  const ids = new Set<string>();
  for (const part of parts) {
    const hit = normalizeIngredientName(index, part);
    if (!hit) return false;
    ids.add(hit.id);
  }
  return ids.size >= 2;
}

/**
 * 把整串名字切成若干个**字典名/别名**（最长优先），切不干净就返回 undefined。
 * 最长优先是为了让 `芝麻酱`、`蒜蓉辣酱` 这类自带条目的名字整段命中（它们在上面的精确命中里
 * 已经返回了，这里是第二道保险）。
 */
function segmentByIngredientNames(index: IngredientIndex, name: string): string[] | undefined {
  const tokens = [...index.byName.keys()].sort((a, b) => b.length - a.length);
  const parts: string[] = [];
  let rest = name;
  while (rest !== '') {
    const hit = tokens.find((token) => rest.startsWith(token));
    if (!hit) return undefined;
    parts.push(hit);
    rest = rest.slice(hit.length);
  }
  return parts.length >= 2 ? parts : undefined;
}

/** 一位小数（拆分的克数均分后不留下 `16.666666666666668` 这种尾巴） */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface NormalizedIngredient {
  ingredientId: string;
  /** 字典里的规范名（落库前的可读形式；报告与测试断言它） */
  name: string;
  adultGrams: number | null;
  quantity: string;
  scaling: 'linear' | 'fixed';
  /**
   * 原文名字（报告里说「它是从哪个叫法归过来的」）。
   * 连写名拆出来的每一条也带着它——「姜蒜 50g」拆成姜/蒜两条时，两条的 `rawName` 都是
   * 「姜蒜」，所以它同时也是「这一项是从哪个连写名来的」的依据，不另设字段。
   */
  rawName: string;
  /** 这一项的名字整串都对不上字典，但名字里**包含**某个字典名字（保守归一，见 normalizeIngredientName） */
  loose?: boolean;
  /** 拆分标记：这条是连写名里的一段（克数已按段数均分），报告与测试靠它认出来 */
  split?: boolean;
}

/**
 * 一个食材名对到字典：先精确（规范名 ∪ 别名），再**保守包含**匹配——
 * 外部数据的名字常带修饰词（「猪五花肉」对「五花肉」、「鲜香菇」对「香菇」、
 * 「青尖椒」对「尖椒」），逐字对不上但显然是同一个食材。
 *
 * 保守包含的边界（重要）：**只在唯一候选时才认**。名字里同时含两个字典名
 * （如「番茄酱」同时含「番茄」与「番茄酱」）时取**最长的那个**匹配；
 * 长度并列仍不唯一就判失败——「猜」出错的代价是把忌口关联建错（隐性忌口靠它展开），
 * 宁可在报告里列一条「归一失败」让人去补别名。
 *
 * 返回 undefined = 归不上（进报告，不落库）。
 */
export function normalizeIngredientName(index: IngredientIndex, rawName: string): { id: string; loose: boolean } | undefined {
  // 名字的清洗有两层：外层剥数据源的书写痕迹（括号/等号尾巴/份量表达式尾巴），
  // 内层（`trimModifiers`）剥切法与品相修饰。两者都只做**确定性的**剥除，不猜词干。
  const cleaned = stripQuantityTail(cleanName(rawName));
  if (cleaned === '') return undefined;

  const exact = index.byName.get(cleaned);
  if (exact) return { id: exact, loose: false };

  // 切口修整：外部数据的名字常带「切法」或「品相」修饰（姜末 / 大葱 / 食用盐 / 鲜香菇）。
  // 先剥一层修饰再查一次精确表——**仍然要求剥完后的名字整字命中字典**，
  // 所以这不放松任何约束，只是把「同一个食材的另一种写法」认出来。
  const trimmed = trimModifiers(index, cleaned);
  if (trimmed) return trimmed;

  // 切口修整之后仍然要经过包含匹配：`五花肉/瘦肉`、`酸奶或牛奶` 这类名字里确实含一个真食材，
  // 既有的「唯一候选才认」已经足够保守（多个候选并列时判失败）。
  // 本票**不在这里加「含 或/ 就判失败」的闸门**：那会把包含匹配本来认得出的名字收紧成失败，
  // 是「归一失败清单变短」这个目标的反向操作。

  let best: { id: string; length: number } | undefined;
  let ambiguous = false;
  for (const [name, id] of index.byName) {
    if (name.length < 2 || !cleaned.includes(name)) continue;
    if (name.length > (best?.length ?? 0)) {
      best = { id, length: name.length };
      ambiguous = false;
    } else if (name.length === best?.length && id !== best.id) {
      ambiguous = true;
    }
  }
  if (!best || ambiguous) return undefined;
  return { id: best.id, loose: true };
}

/**
 * 切法后缀 / 品相前缀的白名单。**只剥一层**：`姜末` → `姜`、`大葱` → `葱`；
 * 剥完仍然要整字命中字典（`土豆淀粉` 剥不出「淀粉」——它前面不是修饰词而是另一个食材名，
 * 那种情况交给上面的「包含匹配」判长度，判不唯一就老老实实进失败清单）。
 *
 * 白名单是封闭的，不搞「猜词干」：猜错一个字的代价是把忌口关联挂错食材
 * （隐性忌口靠食材清单展开），所以宁可少认、把没认出的东西列给人看。
 */
const PREP_SUFFIXES = ['末', '沫', '片', '段', '丝', '蓉', '碎', '丁', '条', '块', '粒'];
const QUALITY_PREFIXES = ['食用', '鲜', '干', '生', '纯', '瘦', '精', '大', '小', '老', '嫩', '新', '熟'];

function trimModifiers(index: IngredientIndex, name: string): { id: string; loose: boolean } | undefined {
  for (const suffix of PREP_SUFFIXES) {
    if (name.length > suffix.length && name.endsWith(suffix)) {
      const hit = index.byName.get(name.slice(0, -suffix.length));
      if (hit) return { id: hit, loose: true };
    }
  }
  for (const prefix of QUALITY_PREFIXES) {
    if (name.length > prefix.length && name.startsWith(prefix)) {
      const hit = index.byName.get(name.slice(prefix.length));
      if (hit) return { id: hit, loose: true };
    }
  }
  return undefined;
}

/**
 * 去掉原文名字里的修饰：反引号/星号（HowToCook 用它们标主料）、全角括号注释、
 * 前后空白、数量词尾巴（「盐量 = 份数」）。
 */
/** 尾巴上的标点/比较符（`姜，`、`食盐 ，`、`水 ≥`）——剥一次后可能又露出新的（`葱、姜、蒜共`），
 * 所以单独抽成一个小函数，与「共/各/总共」「大约/适量」那些尾巴词配合循环剥 */
const TRAILING_PUNCT = /[\s、,，。;；:：≥≤<>~～]+$/g;

/**
 * 名字的**书写痕迹**清洗：反引号/星号、括号注释、`= …` 尾巴、落单的开括号、尾巴上的
 * 标点/聚合词/份量副词。这一层只做**确定性的剥除**，不猜词干（猜词的活交给 `trimModifiers` 的白名单）。
 *
 * 剥的顺序有依赖：先剥标点才能让 `(共|各|总共)$` 锚到真尾巴（`葱、姜、蒜共`），
 * 剥完聚合词又可能露出新标点，所以那两行成对出现。
 */
function cleanName(raw: string): string {
  const withoutDecoration = raw
    .replace(/[`*]/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s*[=＝].*$/, '')
    // 落单的开括号及其后（`猪肉 (`、`盐(`、`蒜水 (`、`鸭肉（`）：闭合的括号已在上一行整体剥掉，
    // 剩下这些是数据源截断的痕迹，留着会让名字永远对不上字典
    .replace(/[（(【[「『].*$/, '');
  // 尾巴上的标点、聚合词（共/各/总共）、份量副词（大约/约/适量）交替剥，直到稳定。
  // 有界循环（最多 4 轮）：尾巴词是封闭集合，剥不完的情况不存在，上限只是防御性写法。
  let current = withoutDecoration;
  for (let round = 0; round < 4; round += 1) {
    const next = current
      .replace(TRAILING_PUNCT, '')
      .replace(/(共|各|总共)$/, '')
      .replace(/[\s]*(大约|大概|约|左右|适量|少许)$/u, '');
    if (next === current) break;
    current = next;
  }
  return current.replace(TRAILING_PUNCT, '').trim();
}

/**
 * 剥掉名字尾巴上的**份量表达式**，留下前面那个真食材名（issue #28 的 44 条杂讯里
 * 最容易被误伤的一类：「牛肉用量为」「盐的用量为」「青椒的数量 = 份数」）。
 *
 * 为什么不能整项丢掉：这些名字里**前面那一截就是真食材**（`牛肉用量为` 就是牛肉、
 * `青椒的数量` 就是青椒）。整项丢就是故事 1 的「买菜清单缺项」。
 * 为什么不能补字典：那是**无穷的写法变体**（`盐量 = 份数`/`盐用量为`/`盐的用量为`/`盐量用量为`），
 * 字典是全库唯一受控表，不能拿它当正则替代品（story 5）。
 *
 * 剥的边界是**封闭的一小组尾巴词**（与 `cleanName` 同一纪律：不猜词干）：
 *   * `量 = …` / `数量 = …` / `用量 = …`（等号后面的整段已在 `cleanName` 里剥掉）
 *   * `的用量为` / `用量为` / `用量` / `的数量` / `数量` / `量`（尾巴词）
 * 剥完剩下空串的（`量 = 份数`）交给 `isNoiseIngredientName` 整项丢掉。
 */
function stripQuantityTail(name: string): string {
  // 循环剥：`盐量用量为` 要剥两层（`用量为` → `量`）才能得到 `盐`。
  // 有界循环（最多 3 轮）：尾巴词是封闭集合，不存在剥不完的情况；上限只是防御性写法。
  let current = name;
  for (let round = 0; round < 3; round += 1) {
    const next = current.replace(/(的)?(用)?(数量|用量|量)(为|＝|=)?$/u, '').trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

/** 归一后仍归不上的、或身份冲突的，怎么处理：拒整道菜（不半截落库） */
export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

export interface NormalizedRecipe {
  id: string;
  name: string;
  aliases: string[];
  kind: RecipeKind;
  effort: DraftRecipe['effort'];
  source: RecipeSource;
  sourceRef: string;
  tastes: TasteTag[];
  seasonMonths: number[];
  cuisine: RecipeCuisine | null;
  steps: string;
  /** 归一后的食材项（**主料在前**：按顺序保留采集顺序，`position` 即下标） */
  ingredients: NormalizedIngredient[];
  /**
   * 这道菜里**名字没对上字典**的项（原文名）。AC 的「归一失败清单」正是它：
   * 与「份量待重标」是两件事——名字归上了、只是原文没写克数，那是 `relabel.pending` 的事。
   */
  unmatchedNames: string[];
  /**
   * 这道菜里被判为**解析杂讯**、整项丢掉的原文名（「盐量 = 份数」类）。
   * 它们与 `unmatchedNames` 分开记：杂讯补字典救不了（research §10 的四分类），
   * 混进「归一失败清单」会让人去补一条不该存在的字典行。丢归丢，报告里**看得见**。
   */
  droppedNames: string[];
}

/**
 * 把一道采集的菜归一到字典上。**只看名字，不改克数**——克数重标是 LLM 的活
 * （`llm/import-schema.ts` 的 `relabelPortions`），两条路各自独立可测。
 *
 * 判失败的两条：① 归上字典的项一个都没有（`deduped.length === 0`）→ 这道菜没有任何可买的东西，
 * 落库只会污染买菜聚合；② `seasonMonths` 出现在 1–12 之外（采集器的 bug，不能替它兜）。
 *
 * 边界说清（这条注释曾经写得比代码严：它说「**主料项**一个都没归上就拒」，而代码从来没这么判过）：
 * 「主料没归上」**不能**判失败——那正是本票要修的缺口（「鲤鱼」「鱼头」这类名字以前不在字典里，
 * 但「糖醋鲤鱼」「红烧鱼头」是真菜，拒掉整道菜比留着缺口更糟）。所以只拒「一个都没归上」。
 * 后果是库里会有若干「只剩调料/水」的草稿（源数据自己就没给主料），它们在台账里记着（
 * `docs/agents/open-items.md` 的「只有调料、没有主料」节），不是本函数的判据。
 */
export function normalizeRecipe(index: IngredientIndex, draft: DraftRecipe): { normalized: NormalizedRecipe; unmatched: string[] } {
  if (draft.ingredients.length === 0) throw new NormalizationError('采集结果里一个食材都没有');

  const normalized: NormalizedIngredient[] = [];
  const unmatched: string[] = [];
  const dropped: string[] = [];
  for (const item of draft.ingredients) {
    // ① 解析杂讯整项丢弃（「盐量 = 份数」类）：不进归一失败清单，但记下来给报告
    if (isNoiseIngredientName(item.name)) {
      dropped.push(item.name);
      continue;
    }
    // ② 归一：**先整串归**（含别名/修饰词/包含匹配那三道既有闸门），归不上才尝试拆分。
    //    顺序要紧：「猪五花肉」自己就能归到五花肉（包含匹配），而拆分会把它变成
    //    「猪五花 + 肉」——那是把一道菜的主料拆成了两个食材，克数还对半分。
    //    所以拆分只是**整串归不上时的降级路**（「姜蒜」这种），不是前置清洗。
    const whole = normalizeIngredientName(index, item.name);
    const names = whole ? [item.name] : splitCombinedIngredientName(index, item.name);
    const split = names.length > 1;
    for (const name of names) {
      const hit = whole ?? normalizeIngredientName(index, name);
      if (!hit) {
        unmatched.push(name);
        continue;
      }
      normalized.push({
        ingredientId: hit.id,
        name: index.nameOf.get(hit.id) ?? hit.id,
        adultGrams: split && item.adultGrams !== null ? round1(item.adultGrams / names.length) : item.adultGrams,
        // 原文照留：报告与 LLM 重标都要能回看「这一笔是怎么来的」
        quantity: item.quantity,
        scaling: item.scaling,
        rawName: item.name,
        loose: hit.loose ? true : undefined,
        split: split ? true : undefined,
      });
    }
  }

  // 同名字段去重：一道菜里同一个食材只留一条（采集器偶尔会给「葱」与「小葱」两条，
  // 归一后指向同一行 → PRIMARY KEY (recipe_id, ingredient_id) 会炸）
  const seen = new Set<string>();
  const deduped = normalized.filter((item) => {
    if (seen.has(item.ingredientId)) return false;
    seen.add(item.ingredientId);
    return true;
  });

  if (deduped.length === 0) {
    // 杂讯丢弃与「归不上」是两件事，拒绝理由要说清是哪种（否则报告会指错方向：
    // 「全是杂讯」该改采集解析，「全是真缺项」才该补字典）
    const noiseNote = dropped.length > 0 ? `（另有 ${dropped.length} 条解析杂讯已丢弃：${dropped.join('、')}）` : '';
    throw new NormalizationError(`食材名全都没对上字典：${unmatched.join('、')}${noiseNote}`);
  }

  for (const month of draft.seasonMonths) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new NormalizationError(`适季月份越界：${month}`);
    }
  }

  return {
    normalized: {
      id: draft.id,
      name: draft.name,
      aliases: draft.aliases,
      kind: draft.kind,
      effort: draft.effort,
      source: draft.source,
      sourceRef: draft.sourceRef,
      tastes: draft.tastes,
      seasonMonths: [...new Set(draft.seasonMonths)].sort((a, b) => a - b),
      cuisine: draft.cuisine,
      steps: draft.steps,
      ingredients: deduped,
      unmatchedNames: unmatched,
      droppedNames: dropped,
    },
    unmatched,
  };
}

// ---------------------------------------------------------------- 落库

export interface ImportOutcome {
  imported: ImportedRecipe[];
  rejected: RejectedRecipe[];
  unmatched: UnmatchedIngredient[];
  /** 被当作解析杂讯丢掉的项（本批，按名字聚合） */
  dropped: DroppedNoise[];
  /**
   * 这一批落库后的重标覆盖率（**在事务里读出来的**）。
   * 为什么不由 `buildReport` 事后查一次库：dry-run 会把事务回滚掉，事后查库读到的是
   * **导入前**的状态——那正是「只算不写」最容易骗人的地方（报告说覆盖率 100%，
   * 实际上你说的是导入前那个 25 项的小库）。在这里带走，两种模式就都是同一份真实数字。
   */
  relabel: RelabelReport;
  /** 采集侧留下的备注（来源不可达、跳过多少道等） */
  notes: string[];
}

export interface ImportOptions {
  /** 已归一的菜（调用方先用 `normalizeRecipe` 过一遍） */
  recipes: NormalizedRecipe[];
  /** 同名菜的处置：'skip' = 跳过（缺省，幂等重跑）；'replace' = 覆盖已有草稿 */
  onConflict?: 'skip' | 'replace';
  /**
   * 只算不写（AC：「导入报告」要能先看一眼）。dry-run 不落库，但报告照出——
   * 于是「这批数据会导入多少、有多少归不上」可以在真正写库前确认。
   */
  dryRun?: boolean;
  /** 采集侧的备注（来源不可达之类），原样进报告 */
  notes?: string[];
}

/**
 * 把一批已归一的菜落库为草稿。**整批一个事务**：要么全进，要么一条不留——
 * 半截导入会让「这次导了多少」与数据库实际状态对不上，报告就成了谎话。
 */
export function importDrafts(db: Db, options: ImportOptions): ImportOutcome {
  const { recipes, onConflict = 'skip', dryRun = false, notes = [] } = options;
  const imported: ImportedRecipe[] = [];
  const rejected: RejectedRecipe[] = [];
  const unmatchedByRecipe: { dish: string; names: string[] }[] = [];
  const droppedByRecipe: { dish: string; names: string[] }[] = [];
  let relabel = relabelReport(db);

  const write = db.transaction((abort: boolean) => {
    for (const recipe of recipes) {
      // 归一失败清单记的是**这批数据**的实际情况，不是「这次真写进去的那几道」的情况：
      // 重跑导入时同名草稿全被 skip，若只记写进去的那些，报告会说「0 条归一失败」——
      // 而库里明明还缺那些别名。清单要能回答「这批快照还有哪些名字对不上字典」。
      if (recipe.unmatchedNames.length > 0) unmatchedByRecipe.push({ dish: recipe.name, names: recipe.unmatchedNames });
      // 杂讯丢弃与归一失败分开收：两者要去的地方不同（改解析 vs 补字典）
      if (recipe.droppedNames.length > 0) droppedByRecipe.push({ dish: recipe.name, names: recipe.droppedNames });

      const clash = db.prepare('SELECT name, status FROM recipes WHERE name = ?').get(recipe.name) as
        | { name: string; status: string }
        | undefined;
      const existing = db.prepare('SELECT status FROM recipes WHERE id = ?').get(recipe.id) as { status: string } | undefined;

      if (existing && existing.status !== 'draft') {
        // 已有同 id 的菜**且不是草稿**（家庭菜谱）：绝不用导入覆盖家里确认过的东西
        rejected.push({
          id: recipe.id,
          name: recipe.name,
          source: recipe.source,
          sourceRef: recipe.sourceRef,
          reason: `同 id 的菜已存在且状态为 ${existing.status}（导入只写草稿，不覆盖家庭菜谱）`,
        });
        continue;
      }
      // 菜名全库唯一（002 的约束）：重名但不同 id 只能跳过，否则 SQLite 直接报 UNIQUE。
      // 同 id 的情形已在上面按 existing 分过流，这里只管「同名不同 id」。
      if (clash && !existing) {
        if (onConflict === 'skip') {
          rejected.push({
            id: recipe.id,
            name: recipe.name,
            source: recipe.source,
            sourceRef: recipe.sourceRef,
            reason: `菜名「${recipe.name}」已存在（状态 ${clash.status}），本次跳过`,
          });
          continue;
        }
        // replace：把已有同名的草稿清掉再写（只清草稿）
        if (clash.status === 'draft') {
          db.prepare('DELETE FROM recipes WHERE name = ?').run(recipe.name);
        } else {
          rejected.push({
            id: recipe.id,
            name: recipe.name,
            source: recipe.source,
            sourceRef: recipe.sourceRef,
            reason: `菜名「${recipe.name}」已被家庭菜谱占用，不能覆盖`,
          });
          continue;
        }
      }

      if (existing && existing.status === 'draft' && onConflict === 'replace') {
        db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.id);
      }
      if (existing && existing.status === 'draft' && onConflict === 'skip') {
        rejected.push({
          id: recipe.id,
          name: recipe.name,
          source: recipe.source,
          sourceRef: recipe.sourceRef,
          reason: '同 id 的草稿已存在（skip），本次跳过',
        });
        continue;
      }

      db.prepare(
        'INSERT INTO recipes (id, name, kind, effort, status, source, cuisine, steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(recipe.id, recipe.name, recipe.kind, recipe.effort, 'draft', recipe.source, recipe.cuisine, recipe.steps);

      for (const alias of recipe.aliases) {
        // 别名全局唯一：别名已被别的菜占着就跳过这条（不因为它把整道菜拒掉）
        db.prepare('INSERT OR IGNORE INTO recipe_aliases (recipe_id, alias) VALUES (?, ?)').run(recipe.id, alias);
      }
      for (const taste of recipe.tastes) {
        db.prepare('INSERT OR IGNORE INTO recipe_tastes (recipe_id, taste) VALUES (?, ?)').run(recipe.id, taste);
      }
      for (const month of recipe.seasonMonths) {
        db.prepare('INSERT OR IGNORE INTO recipe_season_months (recipe_id, month) VALUES (?, ?)').run(recipe.id, month);
      }

      recipe.ingredients.forEach((item, index) => {
        // 没重标的项先落 **0 克**：迁移 005 把 `adult_grams` 的 CHECK 从 `> 0` 放宽为 `>= 0`，
        // 0 就是「模糊份量待 LLM 重标」这个显式状态（见那个迁移的说明）。不这么做的话，
        // 等重标的草稿就进不了库——外部池永远是空的。
        // 报告里的 `relabel.pending` 按它列出来，重标成功后写回正数，状态自然消失。
        // `source_quantity` 存**采集到的份量原文**（「两勺」「约 3~4 斤」）：它是重标的证据
        // （`llm/import-schema.ts` 的纪律 2），也是报告 `relabel.pending` 的显示内容。
        db.prepare(
          `INSERT INTO recipe_ingredients
             (recipe_id, ingredient_id, position, adult_grams, scaling, raw_cooked_anchor, source_quantity)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        ).run(recipe.id, item.ingredientId, index, item.adultGrams ?? 0, item.scaling, item.quantity);
      });

      imported.push({
        id: recipe.id,
        name: recipe.name,
        source: recipe.source,
        sourceRef: recipe.sourceRef,
        ingredients: recipe.ingredients.length,
        relabeled: recipe.ingredients.filter((item) => item.adultGrams !== null).length,
      });
    }
    // 覆盖率**在事务内**读（此时这一批的写入还看得见）——dry-run 回滚后就再也读不到了
    relabel = relabelReport(db);
    // 事务内回滚：dry-run 的一切写入到此为止（见上面的说明）
    if (abort) throw DRY_RUN_ROLLBACK;
  });

  // dry-run 要**先算出结果再回滚**：报告是「只算不写」的唯一产出，不跑一遍就没有数字可看。
  // 回滚点必须在**事务内部**——在 `write()` 返回之后抛，事务已经提交了，那是假 dry-run。
  // （为什么不另写一条「只算」的分支：两条分支迟早对不上，而报告的全部价值就是
  //  它如实反映真正落库会发生什么。）
  try {
    write(dryRun);
  } catch (error) {
    if (error !== DRY_RUN_ROLLBACK) throw error;
  }

  return {
    imported,
    rejected,
    // 这次导入里「名字归不上」的那些（跨菜去重后计数）
    unmatched: aggregateByName(unmatchedByRecipe),
    dropped: aggregateByName(droppedByRecipe),
    relabel,
    notes,
  };
}

/** dry-run 的回滚信号（不是错误，只是让事务回滚） */
const DRY_RUN_ROLLBACK = Symbol('dry-run rollback');

/**
 * 把「哪几道菜里有这个原文名」的清单按名字聚起来（归一失败清单与杂讯清单共用一份口径：
 * 同一个名字跨菜去重、按出现次数降序——报告首先是给人看的，先补影响面最大的）。
 */
function aggregateByName(entries: { dish: string; names: string[] }[]): UnmatchedIngredient[] {
  const byName = new Map<string, { dishes: Set<string>; occurrences: number }>();
  for (const entry of entries) {
    for (const name of entry.names) {
      const hit = byName.get(name);
      if (hit) {
        hit.dishes.add(entry.dish);
        hit.occurrences += 1;
      } else {
        byName.set(name, { dishes: new Set([entry.dish]), occurrences: 1 });
      }
    }
  }
  return [...byName.entries()]
    .map(([name, value]) => ({ name, dishes: [...value.dishes], occurrences: value.occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name, 'zh'));
}

// ---------------------------------------------------------------- 全库视角的报告（AC 的数据指标）

/**
 * 重标覆盖率：**跨全库草稿统计**，不只看本次导入。
 * 它是 AC「重标覆盖率可见」的那条数据指标——导入器每跑一次就重算一次，于是
 * 「这批新导的菜还有多少项是估的」在任何时刻都有一个可重复读到的答案。
 */
export function relabelReport(db: Db): RelabelReport {
  const rows = db
    .prepare(
      `SELECT r.id AS recipe_id, r.name AS recipe_name, i.name AS ingredient_name, ri.adult_grams AS grams,
              ri.source_quantity AS source_quantity
         FROM recipe_ingredients ri
         JOIN recipes r ON r.id = ri.recipe_id
         JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE r.status = 'draft'
        ORDER BY r.rowid, ri.position`,
    )
    .all() as { recipe_id: string; recipe_name: string; ingredient_name: string; grams: number; source_quantity: string | null }[];

  const pending = rows
    .filter((row) => row.grams <= 0)
    .map((row) => ({
      recipeId: row.recipe_id,
      recipeName: row.recipe_name,
      ingredient: row.ingredient_name,
      // 原文是**证据**（`llm/import-schema.ts` 的纪律 2）：报告要能回答「这一项原文写的是什么」
      quantity: row.source_quantity ?? '',
    }));

  // needed 的口径：草稿里的**全部**食材项（重标前的「0 克」与重标后的正数都是被重标过的项）。
  // 覆盖率 = 已重标 / 全部。这样分母不会随重标进度缩小（否则重标一半时覆盖率已经是 100%）。
  const needed = rows.length;
  const done = needed - pending.length;
  return { needed, done, coverage: needed === 0 ? 1 : done / needed, pending };
}

/** 字典里有哪些食材还没录时令（「时令表补全」的欠账清单） */
export function ingredientsWithoutSeason(db: Db): { id: string; name: string }[] {
  return db
    .prepare(
      `SELECT i.id, i.name FROM ingredients i
        WHERE NOT EXISTS (SELECT 1 FROM ingredient_season_months m WHERE m.ingredient_id = i.id)
        ORDER BY i.name`,
    )
    .all() as { id: string; name: string }[];
}

/**
 * 时令手工表的网格形状（总纲 §5「30–40 种常买食材 × 12 月小表」）：
 * 12 列 × 有录月份的食材行——正是那张手工表被录进字典后的样子。
 * 「× 12 月」看的就是这个：**每一列（月）都有食材落上去**，而不是每个食材都填满 12 个月
 * （填满等于把时令信号抹成常量，见迁移 005 的说明）。
 */
export function seasonGrid(db: Db): { month: number; ingredients: { id: string; name: string }[] }[] {
  const rows = db
    .prepare(
      `SELECT m.month AS month, i.id AS id, i.name AS name
         FROM ingredient_season_months m JOIN ingredients i ON i.id = m.ingredient_id
        ORDER BY m.month, i.rowid`,
    )
    .all() as { month: number; id: string; name: string }[];
  return Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    ingredients: rows.filter((row) => row.month === index + 1).map((row) => ({ id: row.id, name: row.name })),
  }));
}

/** 已录时令的食材数（AC：30–40 种；报告与测试都读它，不口头说数字） */
export function seasonIngredientCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(DISTINCT ingredient_id) AS n FROM ingredient_season_months').get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------- 报告组装

/**
 * 组装这次运行的报告（AC：导入量、重标量、归一失败清单）。
 * `unmatched` 是本次导入的归一失败清单；`relabel` 与 `season` 是全库视角的数据指标。
 */
export function buildReport(
  db: Db,
  outcome: ImportOutcome,
  extra: { generatedAt: string; relabel?: RelabelReport },
): ImportReport & { season: { ingredients: number; months: number } } {
  return {
    generatedAt: extra.generatedAt,
    imported: outcome.imported,
    rejected: outcome.rejected,
    // 归一失败清单来自本次落库的结果（`normalizeRecipe` 把原文名带下来了）
    unmatched: outcome.unmatched,
    dropped: outcome.dropped,
    // 覆盖率缺省用事务里带走的那份（dry-run 唯一能看到「若真跑」数字的地方：回滚后再查库
    // 读到的是导入前的小库）。但真跑且已做过 LLM 重标时，**必须**传重读库的那份
    // （`relabelReport(db)`）——重标之后库已经变了，事务里的快照是过期数字，
    // 报告会一边说「N 项写回」一边把同样这 N 项列成「仍待重标」，自相矛盾。
    relabel: extra.relabel ?? outcome.relabel,
    season: { ingredients: seasonIngredientCount(db), months: 12 },
    notes: outcome.notes,
  };
}

// ---------------------------------------------------------------- 份量重标（LLM 离线路径）

/**
 * 把「待重标」（`adult_grams = 0`）的食材项送去 LLM，把回来的克数写回。
 *
 * 三条边界（都是「宁可留着可见的欠账，也不写一个编出来的值」）：
 *   * **失败不抛**：某一批重标不出来就留着 0，报告里 `relabel.pending` 会列出来；
 *   * **只写问过的项**：模型多给/改名的项一律不认（写入按 (recipeId, 食材名) 精确匹配）；
 *   * **只碰草稿**：家庭菜谱的克数是掌勺者确认过的，导入器不许静默改它。
 */
export async function relabelDrafts(
  db: Db,
  llm: LlmClient,
  options: { batchSize?: number; maxAttempts?: number; timeoutMs?: number } = {},
): Promise<{ requests: number; written: number; calls: number; notes: string[] }> {
  const pending = db
    .prepare(
      `SELECT r.id AS recipe_id, r.name AS recipe_name, i.id AS ingredient_id, i.name AS ingredient_name,
              ri.adult_grams AS grams, ri.source_quantity AS source_quantity, ri.position AS position
         FROM recipe_ingredients ri
         JOIN recipes r ON r.id = ri.recipe_id
         JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE r.status = 'draft' AND ri.adult_grams <= 0
        ORDER BY r.rowid, ri.position`,
    )
    .all() as {
    recipe_id: string;
    recipe_name: string;
    ingredient_id: string;
    ingredient_name: string;
    grams: number;
    source_quantity: string | null;
    position: number;
  }[];

  if (pending.length === 0) return { requests: 0, written: 0, calls: 0, notes: [] };

  // 按菜分组送去重标：模型看到整道菜才能给出一组比例合理的份量。
  // `quantity` 送的是**采集到的份量原文**（`source_quantity`）：模型据此把「两勺」「约 3~4 斤」
  // 判成克数——送空串等于让它盲标（`llm/import-schema.ts` 的纪律 2 明写原文是证据）。
  const byRecipe = new Map<string, { name: string; items: RelabelRequest['ingredients'] }>();
  for (const row of pending) {
    const item = { name: row.ingredient_name, quantity: row.source_quantity ?? '' };
    const entry = byRecipe.get(row.recipe_id);
    if (entry) entry.items.push(item);
    else byRecipe.set(row.recipe_id, { name: row.recipe_name, items: [item] });
  }
  const requests: RelabelRequest[] = [...byRecipe.entries()].map(([recipeId, entry]) => ({
    recipeId,
    recipeName: entry.name,
    ingredients: entry.items,
  }));

  const outcome = await relabelPortions(llm, requests, options);

  // 计数按「真的改到行的 UPDATE」来：模型多给的、改了名的、指向家庭菜谱的都不会改到行，
  // 那种条目不该被算成「写回了几项」——报告里的数字要说得出它是怎么来的。
  let written = 0;
  const write = db.transaction(() => {
    const update = db.prepare(
      `UPDATE recipe_ingredients SET adult_grams = ?
        WHERE recipe_id = ? AND ingredient_id = (SELECT id FROM ingredients WHERE name = ?)
          AND adult_grams <= 0
          AND recipe_id IN (SELECT id FROM recipes WHERE status = 'draft')`,
    );
    for (const assignment of outcome.assignments) {
      for (const item of assignment.ingredients) {
        written += update.run(item.grams, assignment.recipeId, item.name).changes;
      }
    }
  });
  write();

  return { requests: pending.length, written, calls: outcome.calls, notes: outcome.notes };
}

/**
 * 菜系参考 tag 的**初打**：只问采集侧启发式说不出确定值的那些草稿（§2.8）。
 * 与重标同一条路：失败不抛、只写草稿、只写校验过的值（白名单在 `llm/import-schema.ts`）。
 */
export async function tagDraftCuisines(
  db: Db,
  llm: LlmClient,
  options: { batchSize?: number; maxAttempts?: number; timeoutMs?: number } = {},
): Promise<{ requests: number; written: number; calls: number; notes: string[] }> {
  const rows = db
    .prepare(`SELECT id AS recipe_id, name AS recipe_name FROM recipes WHERE status = 'draft' AND cuisine IS NULL ORDER BY rowid`)
    .all() as { recipe_id: string; recipe_name: string }[];
  if (rows.length === 0) return { requests: 0, written: 0, calls: 0, notes: [] };

  const outcome = await classifyCuisines(
    llm,
    rows.map((row) => ({ recipeId: row.recipe_id, recipeName: row.recipe_name, tasteHint: [] })),
    options,
  );

  let written = 0;
  const write = db.transaction(() => {
    const update = db.prepare("UPDATE recipes SET cuisine = ? WHERE id = ? AND status = 'draft'");
    for (const [recipeId, cuisine] of outcome.cuisines) {
      written += update.run(cuisine satisfies RecipeCuisine, recipeId).changes;
    }
  });
  write();

  return { requests: rows.length, written, calls: outcome.calls, notes: outcome.notes };
}

/** 报告落盘（报告是 AC 的交付物：导入量、重标量、归一失败清单都要能留档） */
export function writeReport(report: ImportReport & { season: { ingredients: number; months: number } }, filePath: string): void {
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------- 导入编排（CLI 的可测核心）

export interface LibraryImportRequest {
  /** 已归一的菜（调用方先用 `normalizeRecipe` 过一遍） */
  recipes: NormalizedRecipe[];
  /** 采集/归一阶段攒下的被拒条目（快照读不进来的、manifest 登记了但文件缺的），原样并入报告 */
  rejected?: RejectedRecipe[];
  /** 开 LLM 份量重标与菜系初打；只在**真跑**生效（dry-run 一律不调 LLM） */
  useLlm?: boolean;
  dryRun?: boolean;
  onConflict?: 'skip' | 'replace';
  /** 采集侧的备注（来源不可达之类），原样进报告 */
  notes?: string[];
  /** 报告时间戳（调用方在运行开始时取好） */
  generatedAt: string;
}

/**
 * 一整条导入编排：落库 →（真跑且开 LLM 时）份量重标与菜系初打 → 组报告。
 *
 * 为什么从 `scripts/import-library.ts` 抽到这里：**编排顺序本身就是行为**——
 * 「报告的覆盖率读的是哪个时刻的库」只有在这里才测得到。脚本里的 main() 没有测试接缝，
 * 而各自复刻管线的测试恰好都没复刻「重标之后才组报告」这一段。
 */
export async function runLibraryImport(
  db: Db,
  llm: LlmClient,
  request: LibraryImportRequest,
): Promise<ImportReport & { season: { ingredients: number; months: number } }> {
  const outcome = importDrafts(db, {
    recipes: request.recipes,
    dryRun: request.dryRun,
    onConflict: request.onConflict,
    notes: request.notes,
  });
  outcome.rejected.push(...(request.rejected ?? []));

  let relabel = { requests: 0, written: 0, calls: 0, notes: [] as string[] };
  let cuisine = { requests: 0, written: 0, calls: 0, notes: [] as string[] };
  if (request.useLlm && !request.dryRun) {
    relabel = await relabelDrafts(db, llm);
    cuisine = await tagDraftCuisines(db, llm);
    outcome.notes.push(
      `LLM 重标：${relabel.written} 项写回（${relabel.calls} 次调用）；菜系初打：草稿 ${cuisine.written} 道带 tag（${cuisine.calls} 次调用）`,
      ...relabel.notes,
      ...cuisine.notes,
    );
    // 落库与重标都已完成、事务已提交——覆盖率重读库（报告 = 库的真相）。dry-run 不进这里，
    // 继续用事务内的那份快照（「若真跑会发生什么」，回滚后重读只会看到导入前的小库）。
    return buildReport(db, outcome, { generatedAt: request.generatedAt, relabel: relabelReport(db) });
  }

  return buildReport(db, outcome, { generatedAt: request.generatedAt });
}

