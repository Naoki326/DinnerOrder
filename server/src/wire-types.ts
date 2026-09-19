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
}

/** 菜单里一道菜的入参 */
export interface MenuDishInput {
  recipeId: string;
  /** 缺省 false */
  keepLeftover?: boolean;
}

/** `GET /api/slots` 的响应：`today` 是家庭时区的今天（前端按它算「今天/明天」标签） */
export interface SlotsResponse {
  today: string;
  slots: MealSlot[];
}

/** `GET /api/slots/:id` 的响应：当前状态 + 这一餐的全部留痕 */
export interface SlotResponse {
  slot: MealSlot;
  history: MealEvent[];
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

/** `/api/health` 的响应（#13 立的冒烟 API，web 首页页脚用它显示通道状态） */
export interface HealthResponse {
  ok: boolean;
  /** 注入时钟的当前值（测试拨动时钟后经 HTTP 可观测） */
  serverTime: string;
  basePath: string;
  llm: { tools: { name: string; description: string }[] };
}
