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
 * 三条来源共用这一条管线（ADR-0006：HowToCook / 下厨房爬取 / LLM 生成都是「素材层」）：
 *
 *   1. **采集器**（`library/collectors.ts`）把外部数据源读成 `DraftRecipe[]`——纯函数、不碰库；
 *   2. **归一**（本文件 `normalize`）把采集到的食材名对到食材字典的规范名上，对不上的记进
 *      报告（不静默丢、不新建字典行——字典是全库唯一受控表，见 `library/collectors.ts` 的采集口径）；
 *   3. **落库**（本文件 `importDrafts`）写成 `recipes.status='draft'`（外部池的存储形态，
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

export interface NormalizedIngredient {
  ingredientId: string;
  /** 字典里的规范名（落库前的可读形式；报告与测试断言它） */
  name: string;
  adultGrams: number | null;
  quantity: string;
  scaling: 'linear' | 'fixed';
  /** 原文名字（报告里说「它是从哪个叫法归过来的」） */
  rawName: string;
  /** 这一项的名字整串都对不上字典，但名字里**包含**某个字典名字（保守归一，见 normalizeIngredientName） */
  loose?: boolean;
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
  const cleaned = cleanName(rawName);
  if (cleaned === '') return undefined;

  const exact = index.byName.get(cleaned);
  if (exact) return { id: exact, loose: false };

  // 切口修整：外部数据的名字常带「切法」或「品相」修饰（姜末 / 大葱 / 食用盐 / 鲜香菇）。
  // 先剥一层修饰再查一次精确表——**仍然要求剥完后的名字整字命中字典**，
  // 所以这不放松任何约束，只是把「同一个食材的另一种写法」认出来。
  const trimmed = trimModifiers(index, cleaned);
  if (trimmed) return trimmed;

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
const PREP_SUFFIXES = ['末', '片', '段', '丝', '蓉', '碎', '丁', '条', '块', '粒'];
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
function cleanName(raw: string): string {
  return raw
    .replace(/[`*]/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s*[=＝].*$/, '')
    .replace(/[\s:：]+$/g, '')
    .trim();
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
}

/**
 * 把一道采集的菜归一到字典上。**只看名字，不改克数**——克数重标是 LLM 的活
 * （`llm/import-schema.ts` 的 `relabelPortions`），两条路各自独立可测。
 *
 * 判失败的两条：① 主料项（`adultGrams !== null` 或非调料）一个都没归上 → 这道菜没有可买的东西，
 * 落库只会污染买菜聚合；② `seasonMonths` 出现在 1–12 之外（采集器的 bug，不能替它兜）。
 */
export function normalizeRecipe(index: IngredientIndex, draft: DraftRecipe): { normalized: NormalizedRecipe; unmatched: string[] } {
  if (draft.ingredients.length === 0) throw new NormalizationError('采集结果里一个食材都没有');

  const normalized: NormalizedIngredient[] = [];
  const unmatched: string[] = [];
  for (const item of draft.ingredients) {
    const hit = normalizeIngredientName(index, item.name);
    if (!hit) {
      unmatched.push(item.name);
      continue;
    }
    normalized.push({
      ingredientId: hit.id,
      name: index.nameOf.get(hit.id) ?? hit.id,
      adultGrams: item.adultGrams,
      quantity: item.quantity,
      scaling: item.scaling,
      rawName: item.name,
      loose: hit.loose ? true : undefined,
    });
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
    throw new NormalizationError(`食材名全都没对上字典：${unmatched.join('、')}`);
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
    },
    unmatched,
  };
}

// ---------------------------------------------------------------- 落库

export interface ImportOutcome {
  imported: ImportedRecipe[];
  rejected: RejectedRecipe[];
  unmatched: UnmatchedIngredient[];
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
  let relabel = relabelReport(db);

  const write = db.transaction((abort: boolean) => {
    for (const recipe of recipes) {
      // 归一失败清单记的是**这批数据**的实际情况，不是「这次真写进去的那几道」的情况：
      // 重跑导入时同名草稿全被 skip，若只记写进去的那些，报告会说「0 条归一失败」——
      // 而库里明明还缺那些别名。清单要能回答「这批快照还有哪些名字对不上字典」。
      if (recipe.unmatchedNames.length > 0) unmatchedByRecipe.push({ dish: recipe.name, names: recipe.unmatchedNames });

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
    unmatched: aggregateUnmatched(unmatchedByRecipe),
    relabel,
    notes,
  };
}

/** dry-run 的回滚信号（不是错误，只是让事务回滚） */
const DRY_RUN_ROLLBACK = Symbol('dry-run rollback');

function aggregateUnmatched(entries: { dish: string; names: string[] }[]): UnmatchedIngredient[] {
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

