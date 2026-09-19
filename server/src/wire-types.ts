/**
 * 前后端共享的线上类型（ADR-0002、总纲 §6：「共享类型由 server 导出」）。
 *
 * 这里是 web 包**唯一**允许导入的类型来源（`import type { … } from '@dinnerorder/server/types'`）——
 * 前端不再手抄一份同形状的接口。手抄的代价不是几行代码，而是两份定义悄悄漂移：后端把
 * `birthMonth` 改成 `bornMonth`、把 `avoid` 的条目从对象改成字符串，前端要到运行时才发现。
 *
 * 本文件**刻意自包含**（不 import 领域模块）：它只描述 HTTP 线上形状，不应把
 * better-sqlite3 / node:* 那套服务端类型经类型链条拖进前端类型检查。
 * 领域层反过来从本文件取材（见 domain/members.ts、domain/recipes.ts、domain/slots.ts），
 * 因此「线上形状」全仓只有这一处定义。
 */

/** 指向食材字典的条目：id + 规范名（界面直接展示，前端不必再查一次字典） */
export interface IngredientRef {
  ingredientId: string;
  name: string;
}

/** 画像里的一个条目：指向食材字典的规范名 */
export type ProfileEntry = IngredientRef;

/**
 * 爱吃的混合粒度目标（总纲 §2.9）：食材**或**具体菜，不分档。
 * 编辑入参用 `{kind,id}`：两张表的主键各自独立，光给一个字符串无法判断是食材还是菜。
 */
export interface LoveTarget {
  kind: 'ingredient' | 'recipe';
  id: string;
}

/** 爱吃的线上形状：带规范名（菜粒度带菜名；历史里的菜改名后按新名展示，不做名称快照） */
export interface LoveEntry {
  kind: 'ingredient' | 'recipe';
  /** 食材 id 或菜谱 id，取决于 kind */
  id: string;
  name: string;
}

/** 家人画像（总纲 §2.9） */
export interface MemberProfile {
  id: string;
  name: string;
  emoji: string;
  /** 大人 / 小孩 */
  kind: 'adult' | 'child';
  gender: 'male' | 'female';
  /** 出生年月 'YYYY-MM'；小孩必有（#16 按它现算年龄分带折算份量），大人可空 */
  birthMonth: string | null;
  /** 掌勺者（餐后回顾的读者；M1 无权限判定，仅界面标注与默认当前身份） */
  isCook: boolean;
  /** 忌口：硬过滤，本餐任一用餐者命中即排除该菜 */
  avoid: ProfileEntry[];
  /** 爱吃：软加分，混合粒度（总纲 §2.9） */
  loves: LoveEntry[];
}

/** 画像编辑的入参：三块各自独立——没传的块保持原样，传了的块整体替换 */
export interface ProfilePatch {
  /** 出生年月；`null` 表示清空（小孩拒收——#16 分带折算没有依据） */
  birthMonth?: string | null;
  /** 忌口清单（指向食材字典 id）；传了就整体替换——手机上的编辑是一次性提交完整清单 */
  avoid?: string[];
  /** 爱吃清单（食材**或**菜）；传了就整体替换 */
  loves?: LoveTarget[];
}

/** 食材字典里的一条：规范名 + 别名 + 时令月份 + 隐性忌口「含」指针（总纲 §3） */
export interface Ingredient {
  id: string;
  name: string;
  aliases: string[];
  /** 时令月份 1–12；空数组 = 未录 / 四季有售（推荐期只对录了的月份做时令检索） */
  seasonMonths: number[];
  /**
   * 隐性忌口「含」指针（如蚝油含贝类）：食材清单不直接含忌口项、但复合调料里含有。
   * 这里只给**直接**指针；递归展开（含的含）由服务端在菜谱忌口推导里做，前端要的是一次展开后的结果。
   */
  contains: IngredientRef[];
}

/** 菜谱荤素类型：荤 / 素 / 汤（汤分荤素，总纲 §2.8） */
export type RecipeKind = 'meat' | 'veg' | 'soup_meat' | 'soup_veg';

/** 推荐标签：口味**封闭五标签**（多选，总纲 §2.8） */
export type TasteTag = '甜' | '辣' | '酸' | '咸鲜' | '清淡';

/** 难度耗时三档：快手(<20min)/中等/费事 */
export type RecipeEffort = 'quick' | 'medium' | 'heavy';

/** 治理状态机：草稿 → 转正 → 退役（退役不进推荐、历史保留） */
export type RecipeStatus = 'draft' | 'active' | 'retired';

/** 来源：口述 / HowToCook / 下厨房爬取 / LLM 生成 */
export type RecipeSource = 'oral' | 'howtocook' | 'scraped' | 'llm';

/** 菜谱食材项：食材 + 成人份生重基准 + 可缩放规则 + 生熟换算锚点 */
export interface RecipeIngredient {
  ingredientId: string;
  name: string;
  /** 成人份生重克数基准（一个成人一餐这道菜的量，总纲 §2.8） */
  adultGrams: number;
  /**
   * 可缩放规则：`linear` 随用餐者份数缩放；`fixed` 不随人数放大（如虫草花 5g —— 一锅就放这么多）。
   * 份量引擎 #16 用。
   */
  scaling: 'linear' | 'fixed';
  /** 生熟换算锚点（WS/T 554 附录 A 的引用，如「大米 100g ≈ 米饭 220g」）；没锚点的为 null */
  rawCookedAnchor: string | null;
}

/** 菜谱（总纲 §2.8 精简核心集） */
export interface Recipe {
  id: string;
  name: string;
  /** 家人叫法（别名） */
  aliases: string[];
  kind: RecipeKind;
  /** 口味封闭五标签（多选） */
  tastes: TasteTag[];
  /** 适季月份 1–12；空数组 = 四季皆宜 */
  seasonMonths: number[];
  /**
   * 忌口推导结果：本菜食材清单 ∪ 隐性忌口「含」指针递归展开后的食材 id 并集。
   * 推荐期的硬过滤就是拿本餐用餐者的忌口集与它求交（#16/#17）。
   */
  avoidIngredientIds: string[];
  effort: RecipeEffort;
  status: RecipeStatus;
  source: RecipeSource;
  /** 做法步骤自由文本，掌勺者参考用，**不进推荐管线** */
  steps: string;
  ingredients: RecipeIngredient[];
}

/** 餐次：午 / 晚（早餐不进模型） */
export type MealKind = 'lunch' | 'dinner';

/** 餐槽状态：未定 / 已定 */
export type MealSlotStatus = 'undecided' | 'decided';

/** 菜单里的一道菜：指向菜谱 + 留量标记 */
export interface MenuDish {
  recipeId: string;
  name: string;
  kind: RecipeKind;
  /** 多做留到下顿（总纲 §2.6）；上浮生效还要求有有效的「吃剩的」引用（#22） */
  keepLeftover: boolean;
}

/** 用餐者名单快照（默认全员、定餐时可临时改） */
export interface DinerRef {
  memberId: string;
  name: string;
  emoji: string;
}

/** 菜单：已定餐槽的内容 */
export interface Menu {
  diners: DinerRef[];
  dishes: MenuDish[];
}

/** 餐槽（日期 × 餐次） */
export interface MealSlot {
  /** 'YYYY-MM-DD:lunch|dinner'（家庭时区的日历日期） */
  id: string;
  date: string;
  meal: MealKind;
  status: MealSlotStatus;
  /** 未定时为 null */
  menu: Menu | null;
  /** 这一餐还能不能改：过了餐次截止时刻（午 14:00 / 晚 21:00，家庭时区）就不能。服务端按注入时钟判定 */
  editable: boolean;
  /**
   * 这一餐的最后一次变化是不是「换一整套」（accept 一份整餐推荐）——是才给「撤销回上一套」。
   * 服务端从事件流推导，前端不自己猜：撤销的可用性 = 留痕的形状，而不是界面记的一个标志位。
   */
  canUndoSet: boolean;
}

/**
 * 留痕事件类型（ADR-0007、总纲 §3 决议 3）。
 *
 * 「换单道」与「换一整套」分开记：spec 明说两者**各记一条**，而且「换一整套」还要能
 * 反悔回上一套（#18）——若合并成一个值，撤销时不知道该回到哪一个快照。
 */
export type MealEventType = 'decide' | 'replace' | 'replace_set' | 'cancel';

/** 定餐来源：手动挑菜 / 接受整餐推荐（#17 填） */
export type BookingSource = 'manual' | 'recommendation';

/** LLM 调用元数据（#17 落值；模板进代码库 git 管版本） */
export interface LlmCallMeta {
  model: string;
  promptVersion: string;
  latencyMs: number;
  degraded: boolean;
}

/**
 * 这次推荐走的是哪一档。
 *
 * `json_schema` 与 `json_object` 都是 LLM 选的（区别只在端点支不支持 strict schema），
 * `rules_only` 是**简化推荐**——LLM 这轮没参与，界面必须显著标记（总纲 §4 降级链）。
 */
export type RecommendationFormat = 'json_schema' | 'json_object' | 'rules_only';

/** 一条留痕事件（append-only，当前状态由它折叠得出） */
export interface MealEvent {
  seq: number;
  type: MealEventType;
  occurredAt: string;
  source: BookingSource;
  /** 当时的用餐者名单快照；取消事件为空 */
  diners: DinerRef[];
  /** 当时的菜品快照；取消事件为空 */
  dishes: MenuDish[];
  llm: LlmCallMeta | null;
}

/** 定餐/改餐的入参（定餐 = 换菜，同一个编辑器，总纲 §2.1） */
export interface SlotBooking {
  /** 用餐者名单（member id），至少一人；服务端存快照 */
  diners: string[];
  /** 菜品（recipe id），至少一道 */
  dishes: MenuDishInput[];
  /** 缺省 manual；#17 接受推荐时传 recommendation */
  source?: BookingSource;
  /**
   * 接受推荐时回传这次推荐的 LLM 调用元数据（总纲 §3 决议 3：留痕要能回答「为什么推这道」）。
   *
   * 为什么由**客户端回传**而不是服务端凭来源自己推断：推荐接口刻意不落库（不做缓存菜单，
   * 总纲 §4），推荐响应与「接受」是两个请求，服务端此刻没有「上次推荐用了哪个模型」的记忆。
   * 回传的字段只作留痕，不参与任何判定；只允许 `source:'recommendation'` 时携带，
   * 手动定餐带上它是明显的调用错误，直接拒收。
   */
  llm?: LlmCallMeta;
}

// ---------------------------------------------------------------- 整餐推荐（M1-05）

/** 推荐里一道菜的来源：家庭菜谱（做过）/ 外部补位（没做过） */
export type RecipeOrigin = 'family' | 'external';

/** 整餐推荐里的一道菜：只要菜谱 id + 一句理由，份量由份量引擎现算（LLM 不进数值路径，ADR-0004） */
export interface RecommendedDish {
  recipeId: string;
  name: string;
  kind: RecipeKind;
  /** family = 家庭池；external = 外部池补位，界面标「没做过」（spec S6） */
  origin: RecipeOrigin;
  /** LLM 给的一句话理由；简化推荐（无 LLM）时为 null，界面不编造理由 */
  reason: string | null;
}

/** 本餐的家规结构：几位、基线（2 荤 1 素 1 汤）与实际要的菜数（每 ±1 大人 ±1 道菜） */
export interface RecommendationStructure {
  /** 大人用餐者数 */
  adults: number;
  /** 小孩用餐者数 */
  children: number;
  /** 荤菜道数 */
  meat: number;
  /** 素菜道数 */
  veg: number;
  /** 汤道数 */
  soup: number;
}

/** 推荐接口的 LLM 元数据：与留痕同形状，另给「走的哪一档」便于观测降级链 */
export interface RecommendationLlmMeta extends LlmCallMeta {
  format: RecommendationFormat;
}

/** `POST /api/slots/:id/recommendation` 的响应：推荐**不落库**，接受与否由再来一次 PUT 决定 */
export interface MealRecommendation {
  slotId: string;
  /** 这一餐是谁在吃（推荐按这份名单过滤忌口、算家规结构） */
  diners: DinerRef[];
  structure: RecommendationStructure;
  dishes: RecommendedDish[];
  llm: RecommendationLlmMeta;
  /** 降级链的痕迹（简化推荐时非空），界面把原因说清楚而不是只标一个「简化」 */
  notes: string[];
}

/** `POST /api/slots/:id/recommendation` 的入参：用餐者缺省全员（与定餐编辑器的默认同一口径） */
export interface RecommendationRequest {
  /** 用餐者名单（member id）；不传 = 全体家人 */
  diners?: string[];
}

/** `POST /api/slots/:id/recommendation` 的响应包装 */
export interface RecommendationResponse {
  recommendation: MealRecommendation;
}

// ---------------------------------------------------------------- 换菜与候选（M1-06）

/**
 * 换菜候选里的一道菜：菜谱 id + 一句理由，份量照旧由份量引擎现算。
 * 与 `RecommendedDish` 同形状，但来源语义不同（候选是同位替换，不需要结构），
 * 所以分开定义——两者的字段一旦要分化（比如候选带「多久没做」），不必再拆一次。
 */
export interface SwapCandidate {
  recipeId: string;
  name: string;
  kind: RecipeKind;
  /** external = 外部补位池的草稿菜，界面标「没做过」（spec S6） */
  origin: RecipeOrigin;
  /** LLM 给的一句理由；降级为规则排序时为 null，界面不编造理由 */
  reason: string | null;
}

/** 被本餐忌口硬过滤掉的同位菜：说清「为什么它不在候选里」（如「白灼虾 — 小宝忌虾」） */
export interface SwapExcluded {
  recipeId: string;
  name: string;
  /** 排除原因，如「小宝忌虾」；多位用餐者/多项忌口命中用「、」连 */
  reason: string;
}

/**
 * 池干放宽到了哪一档（spec §2.3：同一换菜会话内累积排除，池干后放宽）：
 * `none` = 严格池；`dedupe` = 放回了近 7 天做过的菜（放宽去重）；
 * `session` = 连本次会话排除掉的菜也重新拿出来了（放宽会话排除）。忌口永不 relax。
 */
export type SwapRelaxation = 'none' | 'dedupe' | 'session';

/** `POST /api/slots/:id/candidates` 的响应：一次换菜的候选与它旁边那份「为什么没选它」 */
export interface SwapCandidates {
  slotId: string;
  /** 正在被换掉的那道菜（界面面板标题用） */
  replacing: { recipeId: string; name: string; kind: RecipeKind };
  /** 同位候选，最多 3 个（池子不够就少给，不编造） */
  candidates: SwapCandidate[];
  /** 同位、被本餐忌口排除的菜及原因（忌口是硬过滤，永不进候选） */
  excluded: SwapExcluded[];
  /** 本次取的池放宽到了哪一档 */
  relaxed: SwapRelaxation;
  llm: RecommendationLlmMeta;
  /** 降级链与放宽的痕迹（界面把原因说清楚，而不是只标一个「简化」） */
  notes: string[];
}

/** `POST /api/slots/:id/candidates` 的入参 */
export interface SwapCandidatesRequest {
  /** 要换掉的那道菜（recipe id），必须在当前菜单/草稿里 */
  replacing: string;
  /** 这餐谁吃；不传 = 已定菜单的用餐者快照（未定餐槽必须给） */
  diners?: string[];
  /**
   * 当前菜单（recipe id，按界面上的顺序）。**推荐面板的草稿菜单**用它：
   * 推荐不落库（总纲 §4），那一刻服务端没有「这一套是哪几道菜」的记忆，只能由客户端把它带回来。
   * 已定餐槽不传 = 用服务端快照；两边都拿不到菜单就没有可换的菜（409）。
   */
  dishes?: string[];
  /**
   * 本换菜会话**累积排除**的菜（spec §2.3：被换掉的 + 已出示过的候选）。
   * 服务端把它当软排除：池子还够就不出现，池干时按 relaxed 档放回来。
   */
  exclude?: string[];
}

/** `POST /api/slots/:id/candidates` 的响应包装 */
export interface SwapCandidatesResponse {
  candidates: SwapCandidates;
}

/** 菜单里一道菜的入参 */
export interface MenuDishInput {
  recipeId: string;
  /** 缺省 false */
  keepLeftover?: boolean;
}

/**
 * 餐槽 + 本餐份量（列表与单餐接口都给这个形状，界面不必再打一次份量接口）。
 *
 * 份量**不落库**：年龄随时钟走（小孩生日当天份量就该变），与菜单一起现算。
 * 未定就没有菜单，也就没有份量（null）。
 */
export interface SlotWithPortion extends MealSlot {
  portion: MenuPortion | null;
}

/** `GET /api/slots` 的响应：`today` 是家庭时区的今天（前端按它算「今天/明天」标签） */
export interface SlotsResponse {
  today: string;
  slots: SlotWithPortion[];
}

/** `GET /api/slots/:id` 的响应：当前状态（带份量）+ 这一餐的全部留痕 */
export interface SlotResponse {
  slot: SlotWithPortion;
  history: MealEvent[];
}

// ---------------------------------------------------------------- 份量引擎（M1-04、ADR-0004）

/** 成人能量锚点（折算系数的分母）：轻活动成人全天能量 */
export interface PortionAdultAnchor {
  gender: 'male' | 'female';
  dailyKcal: number;
  source: string;
}

/** 年龄分带折算系数（一份数据资产，来源逐条注明） */
export interface PortionAgeBand {
  id: string;
  label: string;
  /** 周岁闭区间；maxAge 为 null = 成人档（不封顶） */
  minAge: number;
  maxAge: number | null;
  /** male/female 为分性别档；any 为不分性别的档（学龄前 / 成人） */
  gender: 'male' | 'female' | 'any';
  /** 折算系数 = 儿童全天能量 ÷ 同性别成人锚点（派生列；权威量见 recommendationEnergyKcal 与推荐量表） */
  coefficient: number;
  /** 推导依据：WS/T 554 表 1 能量 / 学龄前宝塔推荐量篮比值 / 成人不折算 */
  basis: 'wst554_energy' | 'preschool_basket' | 'adult_anchor';
  /** WS/T 554—2017 表 1 的逐带全天能量（kcal）；非学龄儿童档为 null */
  referenceEnergyKcal: number | null;
  source: string;
}

/** 各人群每天各类食物推荐量（成人平衡膳食宝塔 2022 / 学龄前宝塔） */
export interface PortionRecommendedAmount {
  population: string;
  populationLabel: string;
  groupKey: string;
  groupLabel: string;
  /** 区间下限；只看上限的（盐）为 null */
  minGrams: number | null;
  maxGrams: number;
  unit: string;
  note: string | null;
  source: string;
}

/**
 * 餐次占比（总纲 §5-2，WS/T 554—2017 §3.3）：早 25–30% / 午 35–40% / 晚 30–35%。
 * 「全天量 × 餐次占比」才是单餐量——#22 留量上浮与 #23 买菜清单从这里取。
 */
export interface PortionMealShare {
  meal: 'breakfast' | 'lunch' | 'dinner';
  /** 展示顺序（0=早、1=午、2=晚）。**不是钟点**——餐次钟点属家规（#20），两者语义不同 */
  sortOrder: number;
  /** 占比区间下限（0–1，如 0.35 = 35%） */
  minShare: number;
  /** 占比区间上限（0–1） */
  maxShare: number;
  source: string;
}

/** 折算与推荐量规则表（`GET /api/portion/rules`） */
export interface PortionRules {
  adults: PortionAdultAnchor[];
  bands: PortionAgeBand[];
  recommendedAmounts: PortionRecommendedAmount[];
  /** 餐次占比（全天量 → 单餐量的换算，#22/#23 用） */
  mealShares: PortionMealShare[];
  /** 留量上浮系数（#22）：本票恒 1（没有留量引用就没有上浮，总纲 §2.6） */
  uplift: number;
}

/** 一个用餐者在这份菜单里的折算明细（年龄按请求时刻现算，同一名单必然同结果） */
export interface DinerPortion {
  memberId: string;
  name: string;
  emoji: string;
  kind: 'adult' | 'child';
  /** 现算周岁；没录出生年月的大人为 null */
  ageYears: number | null;
  bandId: string;
  bandLabel: string;
  /** 折算系数（展示用 3 位小数；乘法用未舍入的库内原值） */
  factor: number;
  /** 该用餐者的档位说明（不满最幼档 / 画像标为大人 / 已满 18 岁等） */
  note: string | null;
}

/** 一道菜里一项食材的本餐生重 */
export interface DishIngredientPortion {
  ingredientId: string;
  name: string;
  /** 菜谱的成人份生重基准（原值，便于界面解释「怎么算出来的」） */
  adultGrams: number;
  scaling: 'linear' | 'fixed';
  /** 本餐克数（已取整；fixed 不随人数放大） */
  grams: number;
}

/** 一道菜的本餐生重（逐食材克数 + 合计） */
export interface DishPortion {
  recipeId: string;
  name: string;
  kind: RecipeKind;
  keepLeftover: boolean;
  ingredients: DishIngredientPortion[];
  /** 本菜合计生重 = 各项取整后之和 */
  totalGrams: number;
}

/** 一份菜单的本餐份量（`GET /api/slots/:id` 内嵌、`POST /api/portion/preview` 直取） */
export interface MenuPortion {
  /** 年龄按这一天现算（家庭时区） */
  asOf: string;
  /** 用餐者折算明细（顺序同请求给的名单） */
  diners: DinerPortion[];
  dishes: DishPortion[];
  /** Σ折算系数（未舍入；展示层自己决定保留几位） */
  factorSum: number;
  /** 留量上浮系数（#22）：本票恒 1 */
  uplift: number;
}

/** 互换表里的一条：`grams` 的本品等价于同组 `anchorGrams` 的 `anchorName` */
export interface ExchangeItem {
  id: string;
  groupId: string;
  name: string;
  /** 等价于组内基准量的本品克数（生重/熟重/市品重见 note） */
  grams: number;
  /** 口径提示（生重 / 熟重 / 市品重（含不可食部）…） */
  note: string | null;
  /** 能对上食材字典的条目（#23 买菜聚合复用）；对不上的是市品口径差异，为 null */
  ingredientId: string | null;
}

/** 同类互换组（WS/T 554 附录 A）：主食、蔬菜、水果、鱼肉、肉、大豆、奶 */
export interface ExchangeGroup {
  id: string;
  name: string;
  anchorName: string;
  anchorGrams: number;
  source: string;
  items: ExchangeItem[];
}

/** 一次换算：`grams` 的 `from` 等价于组内每一条的多少克 */
export interface ExchangeConversion {
  group: { id: string; name: string; anchorName: string; anchorGrams: number; source: string };
  from: ExchangeItem;
  grams: number;
  /** 组内每一条的等价克数（含 from 自身，便于界面直接列一张对照） */
  equivalents: { item: ExchangeItem; grams: number }[];
}

/** `POST /api/portion/preview` 的入参：编辑期的草稿菜单（还没落库也要看得见份量） */
export interface PortionPreviewRequest {
  diners: string[];
  dishes: MenuDishInput[];
}

/** `GET /api/history/recent-dishes` 的一条：窗口内做过的菜（按菜谱去重） */
export interface RecentDish {
  recipeId: string;
  name: string;
  kind: RecipeKind;
  /** 窗口内最近一次的那一餐 */
  slotId: string;
  date: string;
  meal: MealKind;
  /** 窗口内出现过几次 */
  times: number;
}

/** `GET /api/portion/rules` 的响应 */
export interface PortionRulesResponse {
  rules: PortionRules;
}

/** `GET /api/portion/exchange` 的响应 */
export interface ExchangeTableResponse {
  groups: ExchangeGroup[];
}

/** `GET /api/portion/exchange/convert` 的响应 */
export interface ExchangeConversionResponse {
  conversion: ExchangeConversion;
}

/** `POST /api/portion/preview` 的响应 */
export interface PortionPreviewResponse {
  portion: MenuPortion;
}

/** `/api/health` 的响应（#13 立的冒烟 API，web 首页页脚用它显示通道状态） */
export interface HealthResponse {
  ok: boolean;
  /** 注入时钟的当前值（测试拨动时钟后经 HTTP 可观测） */
  serverTime: string;
  basePath: string;
  llm: { tools: { name: string; description: string }[] };
}
