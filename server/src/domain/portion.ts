import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type {
  DinerPortion,
  DishPortion,
  ExchangeConversion,
  ExchangeGroup,
  ExchangeItem,
  MenuPortion,
  PortionAdultAnchor,
  PortionAgeBand,
  PortionMealShare,
  PortionRecommendedAmount,
  PortionRules,
  SlotBooking,
} from '../wire-types.js';
import { familyDate } from './family-time.js';
import { EmptyDinersError, resolveDishes, UnknownMemberError } from './slots.js';

/**
 * 份量引擎（总纲 §3 决议 2、§5；ADR-0004）：**纯规则查表**，LLM 不进数值路径。
 *
 * 份量 = 菜谱成人份生重基准 × Σ用餐者折算系数 × 留量上浮（本票恒 1，留量的活是 #22）。
 *
 * 三条口径先说清：
 *
 * 1. **年龄现算**：小孩的周岁按「出生年月 × 注入时钟在家庭时区的今天」算，不存分带。
 *    同一个人 5 月生日前后就是两档（规则表里 9–11 与 12–14 带的系数差 0.156），
 *    存在菜单上就会在生日那天悄悄过期。
 * 2. **系数是派生值**：库里的权威量是「分带能量/推荐量」（WS/T 554—2017 表 1 与两张宝塔），
 *    系数 = 能量 ÷ 同性别成人锚点。领域层直接用库里的系数列（它是入库时算好、有来源可查的），
 *    测试则按「能量 ÷ 锚点」复算一遍做自洽校验——两边对不上就是入库抄错了。
 * 3. **取整时机**：逐项食材算完再取整（150 × 3.164 = 474.6 → 475），不是先逐人取整再相加。
 *    菜的合计是**取整后各项之和**——界面把每行数字加起来要等于合计，不然界面上就露馅。
 */

/** 留量上浮系数（#22：默认 1.5×，是家规不是标准）。本票没有留量引用，恒 1。 */
export const LEFTOVER_UPLIFT = 1;

/** 最幼分带的下界：不满 2 岁的小孩按它兜底（不静默当成人算——那会喂多一倍） */
const YOUNGEST_AGE = 2;

/** 分带上界：满 18 岁按成人份（画像还挂着「小孩」也不改折算，只在说明里讲明） */
const ADULT_AGE = 18;

/** 展示用系数保留位数（乘法用库内原值，不拿舍入后的值去乘） */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 互换换算保留一位小数：界面上不该出现 219.99999 这种数 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 克数取整：四舍五入到整数，`1e-9` 抹平台阶下的浮点误差
 * （0.5 × 100 = 50.000000000000007 这种，不抹的话有时进位有时不进）。
 */
function roundGrams(value: number): number {
  return Math.round(value + 1e-9);
}

// ---------------------------------------------------------------- 规则表（数据资产）

interface BandRow {
  id: string;
  label: string;
  min_age: number;
  max_age: number | null;
  gender: PortionAgeBand['gender'];
  coefficient: number;
  effective_coefficient: number;
  basis: PortionAgeBand['basis'];
  source: string;
  daily_kcal: number | null;
}

function loadBands(db: Db): BandRow[] {
  return db
    .prepare(
      `SELECT b.id, b.label, b.min_age, b.max_age, b.gender, b.coefficient, b.basis, b.source,
              e.daily_kcal,
              -- 有效系数：有权威能量（WS/T 554 的学龄带）就从能量现场除，没有（学龄前宝塔/成人）才用存值。
              -- 取整到 3 位小数 = 规则表本身的精度：既让「能量是权威列」在运行时也成立
              -- （改了能量，份量真的跟着变，不会静默停在旧系数），又让计算与表上写的数字可复算（ADR-0004）。
              COALESCE(ROUND(e.daily_kcal / a.daily_kcal, 3), b.coefficient) AS effective_coefficient
         FROM portion_age_bands b
         LEFT JOIN portion_reference_energy e ON e.band_id = b.id
         LEFT JOIN portion_adult_anchors a ON a.gender = b.gender
        -- 展示顺序：先按周岁低到高，同一年龄带里男、女、any——与 WS/T 554 表 1 的读法一致
        ORDER BY b.min_age, CASE b.gender WHEN 'male' THEN 0 WHEN 'female' THEN 1 ELSE 2 END, b.id`,
    )
    .all() as BandRow[];
}

/** 折算与推荐量规则表（`GET /api/portion/rules`）：界面与调试都要能看见「份量是按什么算的」 */
export function portionRules(db: Db): PortionRules {
  const adults: PortionAdultAnchor[] = (
    db
      .prepare(
        `SELECT gender, daily_kcal, source FROM portion_adult_anchors
          -- 男的在前（与 WS/T 554 表 1 的读法一致）：不依赖字符串序，改注释也不怕
          ORDER BY CASE gender WHEN 'male' THEN 0 ELSE 1 END`,
      )
      .all() as { gender: 'male' | 'female'; daily_kcal: number; source: string }[]
  ).map((row) => ({ gender: row.gender, dailyKcal: row.daily_kcal, source: row.source }));

  const bands: PortionAgeBand[] = loadBands(db).map((row) => ({
    id: row.id,
    label: row.label,
    minAge: row.min_age,
    maxAge: row.max_age,
    gender: row.gender,
    // 与数值路径同源：有权威能量的档现场除（取整到 3 位），没有的用存值——
    // 规则表展示的系数就是份量真正乘的那个数，两边不会各说各的
    coefficient: round3(row.effective_coefficient),
    basis: row.basis,
    referenceEnergyKcal: row.daily_kcal,
    source: row.source,
  }));

  const recommendedAmounts: PortionRecommendedAmount[] = (
    db.prepare(
      `SELECT population, population_label, group_key, group_label, min_grams, max_grams, unit, note, source
         FROM portion_recommended_amounts ORDER BY population, rowid`,
    ).all() as {
      population: string;
      population_label: string;
      group_key: string;
      group_label: string;
      min_grams: number | null;
      max_grams: number;
      unit: string;
      note: string | null;
      source: string;
    }[]
  ).map((row) => ({
    population: row.population,
    populationLabel: row.population_label,
    groupKey: row.group_key,
    groupLabel: row.group_label,
    minGrams: row.min_grams,
    maxGrams: row.max_grams,
    unit: row.unit,
    note: row.note,
    source: row.source,
  }));

  // 餐次占比：全天量 → 单餐量的换算依据（总纲 §5-2；#22 留量、#23 清单都从这里取）
  const mealShares: PortionMealShare[] = (
    db
      .prepare('SELECT meal, sort_order, min_share, max_share, source FROM portion_meal_shares ORDER BY sort_order')
      .all() as {
      meal: PortionMealShare['meal'];
      sort_order: number;
      min_share: number;
      max_share: number;
      source: string;
    }[]
  ).map((row) => ({
    meal: row.meal,
    sortOrder: row.sort_order,
    minShare: row.min_share,
    maxShare: row.max_share,
    source: row.source,
  }));

  return { adults, bands, recommendedAmounts, mealShares, uplift: LEFTOVER_UPLIFT };
}

// ---------------------------------------------------------------- 年龄与分带

/**
 * 周岁 = 出生年月到「家庭时区的今天」的整年数（生日当月进位）。
 *
 * 手算而不是用 Date 的月份差：出生只精确到月，`Date` 会引入「日」这个我们根本没有的信息。
 * 约定：5 月出生的人，5 月 1 日就是新岁数——精确到月是数据能支持的最大精度。
 */
export function ageInYears(birthMonth: string, onDate: string): number {
  const [birthYear, birthMonthNumber] = birthMonth.split('-').map(Number) as [number, number];
  const [year, month] = onDate.split('-').map(Number) as [number, number];
  return year - birthYear - (month < birthMonthNumber ? 1 : 0);
}

interface MemberRow {
  id: string;
  name: string;
  emoji: string;
  kind: 'adult' | 'child';
  gender: 'male' | 'female';
  birth_month: string | null;
}

interface DinerProfile {
  row: MemberRow;
  /** 家人列表里已经查不到这个人（历史菜单的快照），按成人份算并在说明里讲明 */
  missing: boolean;
}

/** 用餐者画像：空名单拒收、未知成员拒收（与定餐同一套语义，复用同一批错误类型） */
function resolveDinerProfiles(
  db: Db,
  memberIds: string[],
  missingMembers: 'error' | 'assumeAdult',
): DinerProfile[] {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) throw new EmptyDinersError();
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, name, emoji, kind, gender, birth_month FROM members WHERE id IN (${placeholders})`)
    .all(...unique) as MemberRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique.map((memberId) => {
    const row = byId.get(memberId);
    if (row) return { row, missing: false };
    // 菜单里的用餐者名单是**当时的快照**（含姓名），家人后来被删也不该让整份菜单读不出来。
    // 没有性别与出生年月可查时按成人份算（不静默折 0），并在档位说明里讲明。
    if (missingMembers === 'assumeAdult') {
      return {
        row: { id: memberId, name: memberId, emoji: '👤', kind: 'adult', gender: 'male', birth_month: null },
        missing: true,
      };
    }
    throw new UnknownMemberError(memberId);
  });
}

interface BandPick {
  band: BandRow;
  ageYears: number | null;
  note: string | null;
}

/**
 * 选带：小孩按性别优先、其次不分性别的档；大人恒成人档（即使画像里录了出生年月——
 * 「大人/小孩」是画像的说法，出生年月只对小孩有折算意义）。
 *
 * 两头都得兜住：不满 2 岁（现实里真有更小的孩子）落最幼档并在 note 里讲明；
 * 满 18 岁还挂在画像「小孩」上的人按成人份算，也在 note 里讲明。静默取默认值
 * 是最坏的选择——家长看到一个说不通的克数，会以为是程序算错了。
 */
function pickBand(bands: BandRow[], profile: MemberRow, onDate: string): BandPick | undefined {
  const adultBand = bands.find((band) => band.basis === 'adult_anchor');
  if (!adultBand) return undefined;
  if (profile.kind === 'adult') {
    return { band: adultBand, ageYears: null, note: null };
  }

  const age = profile.birth_month ? ageInYears(profile.birth_month, onDate) : 0;
  if (age >= ADULT_AGE) {
    return { band: adultBand, ageYears: age, note: `已满 ${ADULT_AGE} 岁，按成人份折算` };
  }

  const inRange = (band: BandRow): boolean =>
    age >= band.min_age && (band.max_age === null || age <= band.max_age);
  const chosen =
    bands.find((band) => inRange(band) && band.gender === profile.gender) ??
    bands.find((band) => inRange(band) && band.gender === 'any');

  if (chosen) return { band: chosen, ageYears: age, note: null };

  // 兜底落在最幼档：比它更小的都没有依据（学龄前宝塔从 2 岁起）
  const youngest = bands
    .filter((band) => band.gender === 'any' && band.basis === 'preschool_basket')
    .sort((a, b) => a.min_age - b.min_age)[0];
  if (!youngest) return undefined;
  return {
    band: youngest,
    ageYears: age,
    note: `不满 ${YOUNGEST_AGE} 岁，按最幼档（${youngest.label}）折算`,
  };
}

// ---------------------------------------------------------------- 份量

export interface PortionInput {
  diners: string[];
  dishes: { recipeId: string; keepLeftover?: boolean }[];
}

export interface PortionOptions {
  /**
   * 名单里有查不到的家人时怎么办：`error`（默认，草稿菜单里选了不存在的人要报错）或
   * `assumeAdult`（读历史菜单用：快照里的人可能已经不在了，菜单不该因此读不出来）。
   */
  missingMembers?: 'error' | 'assumeAdult';
}

/** 一份菜单的本餐份量（`GET /api/slots/:id` 内嵌、`POST /api/portion/preview` 直取） */
export function portionOf(db: Db, clock: Clock, input: PortionInput, options: PortionOptions = {}): MenuPortion {
  const asOf = familyDate(clock.now());
  const bands = loadBands(db);
  const profiles = resolveDinerProfiles(db, input.diners, options.missingMembers ?? 'error');
  // 份量吃的是菜谱的成人份基准，退役与否不影响克数：历史菜单里可能有退役前的菜，
  // 让退役把份量一起挡住，等于把那一餐的读数废掉（#16 只加菜谱库，不改既成事实）
  const dishes = resolveDishes(db, input.dishes as SlotBooking['dishes'], { allowRetired: true });

  const dinerPortions: DinerPortion[] = [];
  let factorSum = 0;
  for (const profile of profiles) {
    const picked = pickBand(bands, profile.row, asOf);
    if (!picked) throw new Error('份量规则表缺少成人档：迁移未按预期执行');
    factorSum += picked.band.effective_coefficient;
    dinerPortions.push({
      memberId: profile.row.id,
      name: profile.row.name,
      emoji: profile.row.emoji,
      kind: profile.row.kind,
      ageYears: picked.ageYears,
      bandId: picked.band.id,
      bandLabel: picked.band.label,
      // 展示用 3 位小数；乘法用未舍入的库内原值（二次舍入会让四个小孩的合计差 1 g）
      factor: round3(picked.band.effective_coefficient),
      note: profile.missing ? '家人列表里已没有这个人（历史名单），按成人份折算' : picked.note,
    });
  }

  const dishPortions: DishPortion[] = dishes.map((dish) => {
    const recipe = findRecipeIngredients(db, dish.recipeId);
    // 留量上浮（#22）：本票 LEFTOVER_UPLIFT 恒 1，所以这里先按菜算好系数就有位置可扩
    const factor = factorSum * (dish.keepLeftover ? LEFTOVER_UPLIFT : 1);
    const ingredients = recipe.map((item) => ({
      ingredientId: item.ingredient_id,
      name: item.name,
      adultGrams: item.adult_grams,
      scaling: item.scaling,
      grams: roundGrams(item.scaling === 'fixed' ? item.adult_grams : item.adult_grams * factor),
    }));
    return {
      recipeId: dish.recipeId,
      name: dish.name,
      kind: dish.kind,
      keepLeftover: dish.keepLeftover,
      ingredients,
      totalGrams: ingredients.reduce((sum, item) => sum + item.grams, 0),
    };
  });

  return { asOf, diners: dinerPortions, dishes: dishPortions, factorSum, uplift: LEFTOVER_UPLIFT };
}

interface IngredientRow {
  ingredient_id: string;
  name: string;
  adult_grams: number;
  scaling: 'linear' | 'fixed';
}

function findRecipeIngredients(db: Db, recipeId: string): IngredientRow[] {
  return db
    .prepare(
      `SELECT ri.ingredient_id, i.name, ri.adult_grams, ri.scaling
         FROM recipe_ingredients ri JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = ? ORDER BY ri.position`,
    )
    .all(recipeId) as IngredientRow[];
}

// ---------------------------------------------------------------- 生熟 / 同类互换（WS/T 554 附录 A）

interface GroupRow {
  id: string;
  name: string;
  anchor_name: string;
  anchor_grams: number;
  source: string;
}

interface ItemRow {
  id: string;
  group_id: string;
  name: string;
  grams: number;
  note: string | null;
  ingredient_id: string | null;
}

/** 互换表：七组，每条带「等价于组内基准多少克」与口径说明（生重/熟重/市品重） */
export function exchangeTable(db: Db): ExchangeGroup[] {
  const groups = db
    .prepare('SELECT id, name, anchor_name, anchor_grams, source FROM exchange_groups ORDER BY rowid')
    .all() as GroupRow[];
  const items = db
    .prepare('SELECT id, group_id, name, grams, note, ingredient_id FROM exchange_items ORDER BY rowid')
    .all() as ItemRow[];

  const itemsByGroup = new Map<string, ExchangeItem[]>();
  for (const row of items) {
    const item: ExchangeItem = {
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      grams: row.grams,
      note: row.note,
      ingredientId: row.ingredient_id,
    };
    const list = itemsByGroup.get(row.group_id);
    if (list) list.push(item);
    else itemsByGroup.set(row.group_id, [item]);
  }

  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    anchorName: group.anchor_name,
    anchorGrams: group.anchor_grams,
    source: group.source,
    items: itemsByGroup.get(group.id) ?? [],
  }));
}

/** 换算时引用了互换表里没有的条目 */
export class UnknownExchangeItemError extends Error {
  constructor(readonly itemId: string) {
    super(`互换表里没有这个条目：${itemId}`);
    this.name = 'UnknownExchangeItemError';
  }
}

/**
 * 换算：`grams` 的 `from` 等价于组内每一条的多少克。
 *
 * 组内每条都表达同一件事——「这条的 grams 等于基准的 anchorGrams」——所以两条之间的换算
 * 就是比例：`目标克数 = 克数 × 目标.grams ÷ 源.grams`。不需要（也不该有）方向性的换算系数列。
 */
export function convertExchange(db: Db, fromId: string, grams: number): ExchangeConversion {
  const groups = exchangeTable(db);
  const from = groups.flatMap((group) => group.items).find((item) => item.id === fromId);
  if (!from) throw new UnknownExchangeItemError(fromId);
  const group = groups.find((entry) => entry.id === from.groupId)!;
  return {
    group: {
      id: group.id,
      name: group.name,
      anchorName: group.anchorName,
      anchorGrams: group.anchorGrams,
      source: group.source,
    },
    from,
    grams,
    equivalents: group.items.map((item) => ({
      item,
      grams: round1((grams * item.grams) / from.grams),
    })),
  };
}
