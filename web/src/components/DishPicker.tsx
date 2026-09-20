import { useMemo, useState } from 'react';
import type { Recipe, RecipeCuisine, RecipeEffort } from '../api/recipes';
import styles from './DishPicker.module.css';

/**
 * 加菜器（#27）：276 道菜里 10 秒挑出一道。
 *
 * 冷启动导入之后草稿池有 257 道「没做过」的外部菜，与家庭菜谱平铺在同一个列表里就是 164 个
 * 按钮——「挑一道没做过的快手荤菜」在界面上根本做不到，而它正是外部菜**手动上桌**的唯一入口
 * （转正的前提是上桌）。这里补三件纯前端的事：
 *   * 名字/别名**模糊搜索** + 主料（食材清单）搜索；
 *   * 「做过 / 没做过」+ 菜系 + 难度三个筛选，可组合；
 *   * 一键清空、筛出多少道的读数、空态提示。
 *
 * 四条口径（本票决议，改之前先读）：
 *   * **筛选只作用于可见性**：已选集合由调用方（`SlotView` 的 `dishes` 草稿）持有，这里既不读也不改
 *     ——「边筛边选」不会把已选的菜弄丢，份量小结照旧按已选全集算。被筛掉的已选菜在这里报个数
 *     （`dish-filter-hidden-chosen`），让人知道它们还在这一餐里。
 *   * **分组与排序不变**：仍按荤/素/汤位分组、组内按名字（`sortForBooking`），退役菜不上加菜器。
 *   * **「没做过」= 草稿**：与按钮上的小标、`CandidateList`、`CONTEXT.md` 的「草稿 = 外部」同一口径
 *     ——**不按 `source` 判定**，同一页不允许有两套「没做过」。
 *   * **状态是本次打开的临时状态**：组件本地 state，不进路由、不进存储、不跨设备。`SlotView` 在
 *     保存/换一整套后整份重挂编辑器，筛选也跟着回到全量（「下次进来是干净的全量」）。
 *   * **默认收起**（#29）：行头一行占位，点开才是搜索 + 筛选 + 按钮。这一屏的主人是「这一餐的菜」
 *     与份量小结，276 道菜铺开时会把整页长度吃掉。收起**只省地方、不丢状态**——`open` 与 `filters`
 *     同住一层，收起再展开搜索词与筛选原样还在；行头上报「已选 N 道」，收起后也不至于忘了挑过什么。
 *
 * 搜索为什么不走后端：276 道家用规模，`GET /recipes?status=all` 的响应里荤素位/难度/状态/菜系/
 * 食材清单本来就齐全，前端过滤零延迟；加一个服务端筛选接口只会多一份要维护的契约（本票零 API 变更）。
 */
export function DishPicker({
  recipes,
  chosen,
  onToggle,
}: {
  /** 全量菜谱（`status=all`，含退役——退役的由 `sortForBooking` 挡在外面） */
  recipes: Recipe[];
  /** 已选的菜（调用方持有：筛选不碰它） */
  chosen: Set<string>;
  /** 点一下加、再点一下去掉（同一份草稿状态） */
  onToggle: (recipeId: string) => void;
}) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  /**
   * 展开/收起，**默认收起**：这一屏的主人是「这一餐的菜」与份量小结，加菜器是第二步才来的东西；
   * 276 道菜铺开时它会把整页长度吃掉（挑完菜要往下滚很久才看得到份量小结）。收起只是省地方，
   * **不丢状态**：`filters` 与 `open` 同住这一层，收起再展开，搜索词与筛选照旧在。
   */
  const [open, setOpen] = useState(false);

  const pool = useMemo(() => sortForBooking(recipes), [recipes]);
  const keyword = filters.query.trim();

  const { visible, ingredientHits } = useMemo(() => {
    const hits = new Map<string, string>();
    const list = pool.filter((recipe) => {
      const match = matchKeyword(recipe, keyword);
      if (!match.hit) return false;
      // 「做过 / 没做过」= 状态：active 是家里做过的，draft 是还没做过（退役的不在池里）
      if (filters.triedness === 'tried' && recipe.status !== 'active') return false;
      if (filters.triedness === 'untried' && recipe.status !== 'draft') return false;
      if (filters.effort !== 'all' && recipe.effort !== filters.effort) return false;
      // 菜系：「未标」那一档专门捞 `cuisine === null` 的（导入期 LLM 初打没跑成），其余档按值相等比
      if (filters.cuisine === 'none' && recipe.cuisine !== null) return false;
      if (filters.cuisine !== 'all' && filters.cuisine !== 'none' && recipe.cuisine !== filters.cuisine) return false;
      if (match.ingredient) hits.set(recipe.id, match.ingredient);
      return true;
    });
    return { visible: list, ingredientHits: hits };
  }, [pool, keyword, filters.triedness, filters.cuisine, filters.effort]);

  const shownIds = useMemo(() => new Set(visible.map((recipe) => recipe.id)), [visible]);
  /** 有没有在筛：逐项与缺省值比，所以**加第四个筛选只需改类型与 `DEFAULT_FILTERS`**（不必记得来这里补一笔） */
  const filtering = (Object.keys(filters) as (keyof Filters)[]).some((key) => filters[key] !== DEFAULT_FILTERS[key]);
  /**
   * 被筛掉的**已选**菜有几道。只数加菜器池子里（非退役）的：退役菜本来就不上加菜器（这条规则先于
   * 筛选、与本票无关），把它们算进「被筛掉」会让这句提示说不清自己指的是哪件事。
   */
  const hiddenChosen = useMemo(
    () => pool.filter((recipe) => chosen.has(recipe.id) && !shownIds.has(recipe.id)).length,
    [pool, chosen, shownIds],
  );

  return (
    <div className="card" data-testid="dish-picker">
      {/* 整行是一个展开/收起开关：收起时只留这一行（右侧写明「展开」），铺开后才是搜索 + 筛选 + 菜按钮 */}
      <button
        type="button"
        className={styles.head}
        data-testid="dish-picker-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.headTitle}>加菜</span>
        <span className={styles.headNote}>
          {open
            ? '点一下加，再点一下去掉'
            : chosen.size > 0
              ? `已选 ${chosen.size} 道`
              : '从菜谱里挑一道'}
        </span>
        <span className={styles.toggle}>{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <>
          <input
            className={styles.search}
            type="text"
            value={filters.query}
            placeholder="搜菜或主料（如 鸡 / 土豆）"
            aria-label="搜菜或主料"
            autoComplete="off"
            enterKeyHint="search"
            data-testid="dish-search-input"
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
          />

          <FilterRow
            label="做过"
            testIdPrefix="filter-status"
            options={TRIEDNESS_OPTIONS}
            value={filters.triedness}
            onPick={(triedness) => setFilters((current) => ({ ...current, triedness }))}
          />

          <FilterRow
            label="难度"
            testIdPrefix="filter-effort"
            options={EFFORT_OPTIONS}
            value={filters.effort}
            onPick={(effort) => setFilters((current) => ({ ...current, effort }))}
          />

          <div className={styles.filterRow}>
            <span className={styles.filterLabel}>菜系</span>
            {/* 菜系用下拉而不是一排 chip：值域有 11 个，铺成 chip 要占三行（手机上把加菜区挤下去），
                而下拉是原生的、拇指友好。与 `ReviewView` 的转正表单同一个做法。 */}
            <select
              className={styles.select}
              aria-label="菜系"
              data-testid="filter-cuisine"
              value={filters.cuisine}
              onChange={(event) => setFilters((current) => ({ ...current, cuisine: event.target.value as CuisineFilter }))}
            >
              <option value="all">全部</option>
              {CUISINE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {/* 「未标」是**必须有的**一档：导入期菜系由 LLM 初打，那一步失败/未跑时 `cuisine` 就是
                  null（迁移 005 允许）。没有这一档，那些菜一旦动了菜系筛选就永远不可达——筛选器不该有
                  看不见的洞。它排在末尾：正常库里它是空的，不该占走「家常」的顺手位置。 */}
              <option value="none">未标</option>
            </select>
          </div>

          <div className={styles.summary}>
            <span className="sub" data-testid="dish-filter-count">
              {filtering ? `筛出 ${visible.length} 道（共 ${pool.length} 道）` : `共 ${pool.length} 道`}
            </span>
            <button
              type="button"
              className={styles.clear}
              data-testid="dish-filter-clear"
              disabled={!filtering}
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              清空筛选
            </button>
          </div>

          {/* 被筛掉的已选菜要有话说：它们仍在「这一餐的菜」与份量小结里，只是这会儿看不见 */}
          {filtering && hiddenChosen > 0 ? (
            <div className={styles.hiddenNote} data-testid="dish-filter-hidden-chosen">
              有 {hiddenChosen} 道已选的菜被筛掉了——它们仍算在这一餐里，清空筛选就能看到。
            </div>
          ) : null}

          {visible.length === 0 ? (
            <div className={styles.empty} data-testid="dish-filter-empty">
              没有同时满足这些条件的菜——换个词，或者点「清空筛选」看全部。
            </div>
          ) : (
            KINDS.map((kind) => {
              const group = visible.filter((recipe) => recipe.kind === kind);
              if (group.length === 0) return null;
              return (
                <div key={kind} className={styles.group} data-testid={`dish-group-${kind}`}>
                  <div className={styles.groupLabel}>{GROUP_LABEL[kind]}</div>
                  <div className={styles.picker}>
                    {group.map((recipe) => {
                      const ingredient = ingredientHits.get(recipe.id);
                      return (
                        <button
                          key={recipe.id}
                          type="button"
                          className={chosen.has(recipe.id) ? `${styles.pick} ${styles.picked}` : styles.pick}
                          data-testid={`pick-${recipe.id}`}
                          aria-pressed={chosen.has(recipe.id)}
                          onClick={() => onToggle(recipe.id)}
                        >
                          {recipe.name}
                          {recipe.status === 'draft' ? <span className={styles.tiny}>没做过</span> : null}
                          {/* 只在「名字没命中、主料命中」时标一句：搜「猪排骨」出的红烧排骨，
                              光看名字不知道为什么它在，标出来才不显得是系统乱给 */}
                          {ingredient ? <span className={styles.matchNote}>含{ingredient}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </>
      ) : null}
    </div>
  );
}

/** 一排筛选 chip（「做过」「难度」两行同形，抽一处免得改一边漏一边） */
function FilterRow<T extends string>({
  label,
  testIdPrefix,
  options,
  value,
  onPick,
}: {
  label: string;
  testIdPrefix: string;
  options: { value: T; label: string }[];
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <div className={styles.filterRow}>
      <span className={styles.filterLabel}>{label}</span>
      <div className={styles.chips}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            data-testid={`${testIdPrefix}-${option.value}`}
            aria-pressed={value === option.value}
            onClick={() => onPick(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type TriednessFilter = 'all' | 'tried' | 'untried';
/** `'none'` = 菜系未标（`cuisine === null`，导入期 LLM 初打没跑成）；`'all'` = 不筛 */
type CuisineFilter = 'all' | 'none' | RecipeCuisine;
type EffortFilter = 'all' | RecipeEffort;

interface Filters {
  query: string;
  /**
   * 「做过 / 没做过」。刻意**不叫** `status`：同名的 `recipe.status`（draft/active/retired）
   * 就在旁边参与判定，两个 status 贴在一起读，正是台账警告过的「同页双口径」那种坑。
   */
  triedness: TriednessFilter;
  cuisine: CuisineFilter;
  effort: EffortFilter;
}

const DEFAULT_FILTERS: Filters = { query: '', triedness: 'all', cuisine: 'all', effort: 'all' };

const TRIEDNESS_OPTIONS: { value: TriednessFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'tried', label: '做过' },
  { value: 'untried', label: '没做过' },
];

const EFFORT_OPTIONS: { value: EffortFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'quick', label: '快手' },
  { value: 'medium', label: '中等' },
  { value: 'heavy', label: '费事' },
];

/**
 * 菜系下拉的选项（总纲 §2.8 的封闭集合）。与 `server/src/llm/import-schema.ts` 的 `CUISINES`
 * **值域同源**，这里只决定界面上的排列顺序（「家常」放最前：草稿池里它最多）。web 不能 import
 * 运行时常量（ADR-0002 只放开类型），所以是照抄而不是引用；真正的把关在服务端
 * （zod 的 `z.enum(CUISINES)` 与迁移 005 的 CHECK）。
 * 另有一份同样的照抄在 `ReviewView`（转正表单的校对下拉）——两处一起改，或者等台账里 #26 的收口。
 */
const CUISINE_OPTIONS: RecipeCuisine[] = ['家常', '川', '粤', '鲁', '苏浙', '湘', '东北', '闽', '徽', '西北', '京'];

/** 荤素汤位的**唯一顺序来源**：分组渲染与 `sortForBooking` 都从它取次序，不各写一份 */
const KINDS = ['meat', 'veg', 'soup_meat', 'soup_veg'] as const;
const GROUP_LABEL: Record<(typeof KINDS)[number], string> = {
  meat: '荤菜',
  veg: '素菜',
  soup_meat: '荤汤',
  soup_veg: '素汤',
};

/**
 * 一条搜索词命中一道菜的两种方式：
 *   * 名字或别名包含（输「鸡」出所有含鸡的菜，输「宫爆」也能找到「宫保鸡丁」的别名）；
 *   * **主料**：食材清单里的规范名包含（输「土豆」出黄焖鸡这类名字里没有土豆的菜）。
 * 命中主料时把那个食材名带回去，界面上标一句「含土豆」——否则用户看不出这道菜为什么在。
 *
 * 只做**包含匹配**、不做拼音/同义词：食材名走的是字典的规范名（别名匹配要另拉一份字典，
 * 本票的零 API 变更约束下不做；要搜「西红柿」找「番茄」是字典补录那一票的事）。
 */
function matchKeyword(recipe: Recipe, keyword: string): { hit: boolean; ingredient?: string } {
  if (keyword === '') return { hit: true };
  if (recipe.name.includes(keyword) || recipe.aliases.some((alias) => alias.includes(keyword))) {
    return { hit: true };
  }
  const ingredient = recipe.ingredients.find((item) => item.name.includes(keyword));
  return ingredient ? { hit: true, ingredient: ingredient.name } : { hit: false };
}

/**
 * 加菜的顺序：先按荤素汤位、再按名字，顺序稳定、不随请求回来的次序漂移。
 * 退役的菜不上加菜器（家里不再做；要吃先转正），草稿留着——它是外部补位池的菜（spec S6）。
 */
function sortForBooking(recipes: Recipe[]): Recipe[] {
  return recipes
    .filter((recipe) => recipe.status !== 'retired')
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, 'zh'));
}
