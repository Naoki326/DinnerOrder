import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Recipe } from '@dinnerorder/server/types';
import { useRecipes } from '../api/recipes';
import { useIdentity } from '../identity';
import { RecipeEditor } from '../components/RecipeEditor';
import {
  EFFORT_LABELS,
  KIND_FILTER_OPTIONS,
  KIND_LABELS,
  kindMatches,
} from '../components/recipeVocabulary';
import styles from './RecipeLibraryView.module.css';

/**
 * 菜谱库（issue #30；ADR-0009）：设置里的一个**独有页面**（`/recipes`）。
 *
 * 三档 tab（家庭菜谱 / 外部菜谱 / 已退役）＋档内搜索。这一页不占用底部导航（壳用 `hideTabBar`）、
 * 顶部一个「← 设置」返回——它是从设置钻进来的从属页面，不是第五个日常页。
 *
 * 五条口径（改之前先读）：
 *   * **三档就是状态机的三个状态**（active / draft / retired），不是另立的分类：
 *     「家庭菜谱」= active、「外部菜谱」= draft、「已退役」= retired。档位与 `recipe.status` 一一对应。
 *   * **「没做过」与「还没上过桌」刻意不同、不得混用**：外部菜档那句是「没做过」（判定源 `status`），
 *     家庭菜档那句是「还没上过桌」（判定源是派生的 `neverServed`，见 `wire-types.ts` 的 `Recipe`）。
 *     **同一个渲染点只出现一种**——两者判定源不同，混在一行里就是台账点名要避免的「同页双口径」。
 *   * **外部菜档默认只给「待处理」子集**（克数待定的 + 还没细看过的），带一个**可关闭的开关**能切回全部。
 *     做成开关而不是写死：这个分组在真数据出来之前无法验证好用与否，要能随时改。
 *   * **只有掌勺者可写**：回落全局 `is_cook`（菜谱不属于任何一餐，没有「那一餐的掌勺者」可用）。
 *     非掌勺者看到只读的库，知道该找谁改。
 *   * **筛选是纯前端**（与 `DishPicker` 同一纪律）：`GET /recipes?status=all` 一次拿齐，
 *     零额外 API 契约。
 */
type LibraryTab = 'family' | 'external' | 'retired';

const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'family', label: '家庭菜谱' },
  { id: 'external', label: '外部菜谱' },
  { id: 'retired', label: '已退役' },
];

/** 家庭菜档的荤/素/汤位筛选（与加菜器同一口径：三档，汤吃掉荤汤+素汤） */
type KindFilter = 'all' | 'meat' | 'veg' | 'soup';

export function RecipeLibraryView() {
  const { current } = useIdentity();
  const recipes = useRecipes('all');
  const [tab, setTab] = useState<LibraryTab>('family');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [pendingOnly, setPendingOnly] = useState(true);
  /** 正在看哪一道（null = 在列表上） */
  const [openId, setOpenId] = useState<string | null>(null);

  const all = recipes.data ?? [];
  const canWrite = current?.isCook ?? false;

  const family = useMemo(() => all.filter((recipe) => recipe.status === 'active'), [all]);
  const external = useMemo(() => all.filter((recipe) => recipe.status === 'draft'), [all]);
  const retired = useMemo(() => all.filter((recipe) => recipe.status === 'retired'), [all]);

  const keyword = query.trim();
  const visible = useMemo(() => {
    const pool = tab === 'family' ? family : tab === 'external' ? external : retired;
    return pool
      .filter((recipe) => matchKeyword(recipe, keyword))
      .filter((recipe) => (tab === 'family' ? kindMatches(recipe.kind, kind) : true))
      // 外部菜档的「只看待处理」：克数待定（hasPendingRelabel）或还没细看过（没有步骤，
      // 也就是导入时还没被 LLM 打过菜系/写做法的那种）。关掉开关就能看全部素材。
      .filter((recipe) => (tab === 'external' && pendingOnly ? isPending(recipe) : true))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [tab, family, external, retired, keyword, kind, pendingOnly]);

  const open = openId ? all.find((recipe) => recipe.id === openId) : undefined;

  if (open) {
    return (
      <div data-testid="recipe-library-view">
        <BackRow onBack={() => setOpenId(null)} backLabel="← 菜谱库" />
        {canWrite ? (
          <RecipeEditor recipe={open} memberId={current?.id} />
        ) : (
          <div className="card" data-testid="recipe-cook-only">
            <b>{open.name}</b>
            <div className="sub" style={{ marginTop: 6 }}>
              改菜谱是掌勺者的事——让家里通常做菜的那位来改。
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-testid="recipe-library-view">
      <BackRow onBack={undefined} backLabel="← 设置" />

      <div className="card">
        <div className="spread">
          <b>菜谱库</b>
          <span className="badge">{all.length} 道</span>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>
          录入新菜、改做法、退役不做的菜。{canWrite ? '' : '改菜谱是掌勺者的事。'}
        </div>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="菜谱档位">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`recipe-tab-${item.id}`}
            className={tab === item.id ? `${styles.tab} ${styles.tabOn}` : styles.tab}
            onClick={() => {
              setTab(item.id);
              setQuery('');
            }}
          >
            {item.label}
            <span className={styles.count}>
              {item.id === 'family' ? family.length : item.id === 'external' ? external.length : retired.length}
            </span>
          </button>
        ))}
      </div>

      <div className="card" data-testid={`recipe-list-${tab}`}>
        <input
          className={styles.search}
          type="text"
          value={query}
          placeholder={tab === 'external' ? '搜菜名或主料（如 豆芽）' : '搜菜名'}
          aria-label="搜菜名"
          autoComplete="off"
          enterKeyHint="search"
          data-testid="recipe-search-input"
          onChange={(event) => setQuery(event.target.value)}
        />

        {tab === 'family' ? (
          <div className={styles.filterRow}>
            <span className={styles.filterLabel}>荤素</span>
            <div className={styles.chips}>
              {KIND_FILTER_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={kind === option.value ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                  data-testid={`recipe-filter-kind-${option.value}`}
                  aria-pressed={kind === option.value}
                  onClick={() => setKind(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {tab === 'external' ? (
          <div className={styles.filterRow}>
            <span className={styles.filterLabel}>范围</span>
            <div className={styles.chips}>
              <button
                type="button"
                className={pendingOnly ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                data-testid="recipe-pending-toggle"
                aria-pressed={pendingOnly}
                onClick={() => setPendingOnly((value) => !value)}
              >
                {pendingOnly ? '只看待处理' : '看全部素材'}
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.summary}>
          <span className="sub" data-testid="recipe-count">
            {visible.length} 道
            {tab === 'external' && pendingOnly ? '（待处理）' : ''}
          </span>
          {canWrite && tab !== 'retired' ? (
            <span className="sub">点一道菜就能改</span>
          ) : (
            <span className="sub">点一道菜看详情</span>
          )}
        </div>

        {visible.length === 0 ? (
          <div className={styles.empty} data-testid="recipe-empty">
            {keyword === ''
              ? tab === 'external' && pendingOnly
                ? '这一档里没有待处理的素材——切到「看全部素材」看看全部。'
                : '这一档里还没有菜谱。'
              : '没有名字或主料对得上的菜谱——换个词试试。'}
          </div>
        ) : (
          visible.map((recipe) => (
            <RecipeRow
              key={recipe.id}
              recipe={recipe}
              tab={tab}
              canWrite={canWrite}
              onOpen={() => setOpenId(recipe.id)}
              onPendingToggle={
                tab === 'external' ? () => setQuery(recipe.name) : undefined
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

/** 顶部返回行。`onBack` 为空时是「← 设置」的链接（列表页），有值时是「← 菜谱库」（详情页）。 */
function BackRow({ onBack, backLabel }: { onBack: (() => void) | undefined; backLabel: string }) {
  return (
    <div className={styles.backRow}>
      {onBack ? (
        <button type="button" className={styles.back} data-testid="recipe-back" onClick={onBack}>
          {backLabel}
        </button>
      ) : (
        <Link className={styles.back} data-testid="recipe-back-settings" to="/">
          {backLabel}
        </Link>
      )}
    </div>
  );
}

/**
 * 列表里的一行：菜名 + 荤素汤位 + 该档该有的标记。
 *
 * **标记按档位分开**（不得混用，见文件头）：
 *   * 家庭菜档：`neverServed` → 「还没上过桌」；`hasPendingRelabel` → 「有克数没定」
 *   * 外部菜档：`status==='draft'` → 「没做过」；`hasPendingRelabel` → 「有克数没定」
 *   * 已退役档：不标（它既不是「没做过」也不是「还没上过桌」）
 */
function RecipeRow({
  recipe,
  tab,
  canWrite,
  onOpen,
  onPendingToggle,
}: {
  recipe: Recipe;
  tab: LibraryTab;
  canWrite: boolean;
  onOpen: () => void;
  onPendingToggle?: () => void;
}) {
  return (
    <button type="button" className={styles.row} data-testid={`recipe-row-${recipe.id}`} onClick={onOpen}>
      <span className={styles.rowMain}>
        <span className={styles.name}>{recipe.name}</span>
        <span className="sub">
          {KIND_LABELS[recipe.kind]} · {EFFORT_LABELS[recipe.effort]}
          {recipe.cuisine ? ` · ${recipe.cuisine}` : ''}
        </span>
      </span>
      <span className={styles.badges}>
        {tab === 'external' ? <span className="badge">没做过</span> : null}
        {tab === 'family' && recipe.neverServed ? (
          <span className="badge acc" data-testid={`recipe-never-served-${recipe.id}`}>
            还没上过桌
          </span>
        ) : null}
        {recipe.hasPendingRelabel ? (
          <span className="badge warn" data-testid={`recipe-pending-${recipe.id}`}>
            有克数没定
          </span>
        ) : null}
      </span>
      {/* 行内的「待处理」快捷：把搜索词设成这道菜的名字（纯前端，不回服务端） */}
      {onPendingToggle && recipe.hasPendingRelabel ? (
        <span
          role="button"
          tabIndex={0}
          className={styles.rowAction}
          data-testid={`recipe-focus-${recipe.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onPendingToggle();
          }}
        >
          补克数
        </span>
      ) : null}
      {!canWrite ? <span className="sub">只读</span> : null}
    </button>
  );
}

/**
 * 搜索命中一道菜的两种方式（与 `DishPicker.matchKeyword` 同一口径）：
 * 名字/别名包含，或**主料**（食材清单里的规范名）包含。
 * 外部菜档要按主料搜就是为这个：250 道素材里「找某道我听说过的菜」常常只记得主料。
 */
function matchKeyword(recipe: Recipe, keyword: string): boolean {
  if (keyword === '') return true;
  if (recipe.name.includes(keyword) || recipe.aliases.some((alias) => alias.includes(keyword))) return true;
  return recipe.ingredients.some((item) => item.name.includes(keyword));
}

/**
 * 「待处理」的判定（外部菜档专用）：克数待定**或**还没细看过。
 *
 * 「还没细看过」= 没有做法步骤（`steps === ''`）。导入期的素材大多只有食材清单，
 * 做法与菜系是 LLM 初打那一步补的——没跑那一步的菜在界面上就是「还没细看」。
 * **这条口径若被改，`docs/agents/open-items.md` 里那条欠账要一并改**（本票如实标注为待验证）。
 */
function isPending(recipe: Recipe): boolean {
  return recipe.hasPendingRelabel || recipe.steps.trim() === '';
}
