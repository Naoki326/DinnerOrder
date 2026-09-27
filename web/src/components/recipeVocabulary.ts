import type { RecipeCuisine, RecipeEffort, RecipeKind, TasteTag } from '@dinnerorder/server/types';

/**
 * 菜谱界面的**词汇表**（issue #30）：荤素汤位、难度、口味、菜系的展示标签与值域顺序。
 *
 * 为什么单独一处：这些映射在 `DishPicker`（筛选）、`ReviewView`（转正表单）与新的菜谱库页面
 * 三处都要用，各抄一份就会漂移（加一个口味标签要记着改三处）。**web 不能 import 服务端的
 * 运行时常量**（ADR-0002 只放开类型），所以这里是照抄，真正的把关在服务端
 * （zod 的 `z.enum` 与迁移 005/006 的 CHECK）。
 */

/** 荤素汤位（库里四个 `kind`）的展示名。**顺序即界面顺序**（荤 → 素 → 汤） */
export const KIND_LABELS: Record<RecipeKind, string> = {
  meat: '荤菜',
  veg: '素菜',
  soup_meat: '荤汤',
  soup_veg: '素汤',
};

/** 荤素汤位在表单里的可选项（四个 kind 都要能选——表单编辑的是菜谱属性，不是筛选） */
export const KIND_OPTIONS: { value: RecipeKind; label: string }[] = [
  { value: 'meat', label: KIND_LABELS.meat },
  { value: 'veg', label: KIND_LABELS.veg },
  { value: 'soup_meat', label: KIND_LABELS.soup_meat },
  { value: 'soup_veg', label: KIND_LABELS.soup_veg },
];

export const EFFORT_LABELS: Record<RecipeEffort, string> = {
  quick: '快手',
  medium: '中等',
  heavy: '费事',
};

export const EFFORT_OPTIONS: { value: RecipeEffort; label: string }[] = [
  { value: 'quick', label: EFFORT_LABELS.quick },
  { value: 'medium', label: EFFORT_LABELS.medium },
  { value: 'heavy', label: EFFORT_LABELS.heavy },
];

/** 口味封闭五标签（与迁移 006 的 CHECK 同源） */
export const TASTE_OPTIONS: TasteTag[] = ['甜', '辣', '酸', '咸鲜', '清淡'];

/**
 * 菜系下拉的选项（总纲 §2.8 的封闭集合）。与 `server/src/llm/import-schema.ts` 的 `CUISINES`
 * **值域同源**，这里只决定界面上的排列顺序（「家常」放最前：草稿池里它最多）。
 * 另有一份同样的照抄在 `DishPicker` 与 `ReviewView`（都是各自的筛选/校对下拉）。
 */
export const CUISINE_OPTIONS: RecipeCuisine[] = ['家常', '川', '粤', '鲁', '苏浙', '湘', '东北', '闽', '徽', '西北', '京'];

/** 家庭菜档的荤/素/汤位筛选（三档；「汤」同时吃掉荤汤 + 素汤，与 `DishPicker` 同一口径） */
export type KindFilter = 'all' | 'meat' | 'veg' | 'soup';

export const KIND_FILTER_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'meat', label: '荤' },
  { value: 'veg', label: '素' },
  { value: 'soup', label: '汤' },
];

/**
 * 荤素汤位三档 → 库里四个 `kind` 的映射（**只此一处**：筛选与分组不会各维护一份判定）。
 * 「汤」一档吃掉荤汤 + 素汤：家里想的是「来个汤」，不是「荤汤还是素汤」。
 */
export function kindMatches(kind: RecipeKind, filter: KindFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'soup') return kind === 'soup_meat' || kind === 'soup_veg';
  return kind === filter;
}
