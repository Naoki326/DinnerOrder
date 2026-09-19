import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useIdentity } from '../identity';
import { useRecipes, type Recipe } from '../api/recipes';
import { usePortionPreview, type MenuPortion } from '../api/portion';
import { useBookSlot, useCancelSlot, useSlot, type MealEvent, type MealSlot } from '../api/meals';
import { useAcceptRecommendation, useRecommendation } from '../api/recommendations';
import { useUndoSet } from '../api/replacements';
import { CandidateList } from '../components/CandidateList';
import styles from './SlotView.module.css';

/**
 * 定餐编辑器（总纲 §2.1「定餐 = 换菜，同一编辑器」）。
 *
 * 一屏里三件事：挑菜（按荤/素/汤分组，点一下加/减）、改用餐者名单（默认全员，可临时改）、
 * 保存为已定 / 取消。菜单是**整份提交**的：服务端把每次提交记成一条留痕事件，
 * 前端不做「加一道菜就发一次接口」的增量同步——半份状态就有地方藏。
 *
 * 份量（总纲 §3 决议 2）跟着名单与菜单**即时重算**：勾掉小宝，排骨的克数当场就变。
 * 算的规则只有服务端一份（年龄要按服务端时钟现算），所以这里打 `/api/portion/preview`
 * 而不是自己乘——前端各算各的就会在小孩生日、跨零点时与服务端打架。
 *
 * 下面还列着这一餐的留痕（append-only）：改过什么、什么时候改的，翻历史看得到。
 */
export function SlotView() {
  const { slotId } = useParams<{ slotId: string }>();
  const slotQuery = useSlot(slotId);
  const recipesQuery = useRecipes('all');

  // 换菜会话的排除集（被换掉的 + 已出示过的候选）挂在外层：`key` 重挂载 SlotEditor
  // （保存/换套/撤销后服务端菜单变了）时它不跟着丢——被换掉的那道菜不该因为一次保存
  // 又回到候选里（spec §2.3 的累积排除）。草稿（dishes/dinersDraft）的重挂载重置仍留在
  // SlotEditor 里，那是有意的。会话的生命周期 = 这个餐槽页面的生命周期。
  // 状态里带上槽位 id：客户端路由在两个餐槽页之间往返会复用这个组件实例，换槽即新会话、不串台。
  const [session, setSession] = useState({ slotId, excludes: [] as string[] });
  const sessionExcludes = session.slotId === slotId ? session.excludes : [];
  const excludeDishes = (recipeIds: string[]): void => {
    setSession((current) => ({
      slotId,
      excludes: [...new Set([...(current.slotId === slotId ? current.excludes : []), ...recipeIds])],
    }));
  };

  if (slotQuery.isPending || recipesQuery.isPending) {
    return (
      <div className="card sub" data-testid="slot-loading">
        读取中…
      </div>
    );
  }
  if (slotQuery.isError || !slotQuery.data) {
    return (
      <div className="card" data-testid="slot-error">
        <b>这一餐没读回来</b>
        <div className="sub" style={{ marginTop: 6 }}>
          {slotQuery.error instanceof Error ? slotQuery.error.message : '检查一下地址或服务'}
        </div>
        <div style={{ marginTop: 10 }}>
          <Link className="btn ghost" to="/">
            回首页
          </Link>
        </div>
      </div>
    );
  }

  // 数据到位后才挂载编辑器：hooks 不必为「还没数据」的空态分叉。
  // `key` 用最后一条事件的 seq：保存/换一整套/撤销之后服务端状态变了，整份草稿要跟着重挂载
  // ——编辑器里的 useState 只在挂载时取一次初值，不重挂就会把旧草稿留在屏幕上报销掉服务端的新菜单。
  // 会话排除集不走这条路：它由上面这层持有，重挂载不会清空。
  return (
    <SlotEditor
      key={slotQuery.data.history.at(-1)?.seq ?? 'new'}
      slot={slotQuery.data.slot}
      history={slotQuery.data.history}
      recipes={recipesQuery.data ?? []}
      sessionExcludes={sessionExcludes}
      onExclude={excludeDishes}
    />
  );
}

interface DraftDish {
  recipeId: string;
  keepLeftover: boolean;
}

function SlotEditor({
  slot,
  history,
  recipes,
  sessionExcludes,
  onExclude,
}: {
  slot: MealSlot;
  history: MealEvent[];
  recipes: Recipe[];
  /**
   * 本换菜会话的排除集，由外层 `SlotView` 持有（spec §2.3 的累积排除跨保存/换套/撤销仍然有效）。
   * 面板一关一开（组件卸载重挂）不能把「被换掉的 + 已出示过的」弄丢。
   */
  sessionExcludes: string[];
  /** 把菜并进会话排除集（被换掉的 + 面板已出示过的候选） */
  onExclude: (recipeIds: string[]) => void;
}) {
  const navigate = useNavigate();
  const { members } = useIdentity();
  const book = useBookSlot();
  const cancel = useCancelSlot();
  const [error, setError] = useState<string | undefined>(undefined);

  // 本地草稿：编辑期间不动服务端，一次提交才是「菜单变了」的那个瞬间
  const [dinersDraft, setDinersDraft] = useState<string[] | null>(null);
  const [dishes, setDishes] = useState<DraftDish[]>(
    () => slot.menu?.dishes.map((dish) => ({ recipeId: dish.recipeId, keepLeftover: dish.keepLeftover })) ?? [],
  );

  // 换菜（spec S2）：只记「正在换哪一道」；候选本身由 CandidateList 取，
  // 而**本会话的排除集**（被换掉的 + 已出示过的）在 SlotView 那一层——「换它」即关面板，
  // 状态留在面板组件里就随 unmount 丢了，同一会话里换掉的那道菜会重新进候选（spec §2.3）。
  const [swapping, setSwapping] = useState<string | null>(null);
  const undo = useUndoSet(slot.id);
  const recommend = useRecommendation(slot.id);
  const accept = useAcceptRecommendation(slot.id);

  // 首次定餐的默认用餐者是**全员**（总纲 §3）；家人列表可能晚于餐槽到位，所以默认值现算而不是初值快照
  const diners = dinersDraft ?? (slot.menu ? slot.menu.diners.map((diner) => diner.memberId) : members.map((m) => m.id));

  // 份量随草稿名单/菜品即时重算（服务端算，前端只显示）
  const portionQuery = usePortionPreview(diners, dishes);
  const portion = portionQuery.data;
  const factorOf = useMemo(
    () => new Map((portion?.diners ?? []).map((diner) => [diner.memberId, diner])),
    [portion],
  );

  const byId = useMemo(() => new Map(recipes.map((recipe) => [recipe.id, recipe])), [recipes]);
  const chosen = useMemo(() => new Set(dishes.map((dish) => dish.recipeId)), [dishes]);
  const pool = useMemo(() => sortForBooking(recipes), [recipes]);

  const toggleDiner = (memberId: string): void => {
    setDinersDraft(diners.includes(memberId) ? diners.filter((id) => id !== memberId) : [...diners, memberId]);
  };

  const toggleDish = (recipeId: string): void => {
    setDishes((current) =>
      current.some((dish) => dish.recipeId === recipeId)
        ? current.filter((dish) => dish.recipeId !== recipeId)
        : [...current, { recipeId, keepLeftover: false }],
    );
  };

  const toggleKeep = (recipeId: string): void => {
    setDishes((current) =>
      current.map((dish) => (dish.recipeId === recipeId ? { ...dish, keepLeftover: !dish.keepLeftover } : dish)),
    );
  };

  /** 「换它」：只改本地草稿——保存由用户按下「保存改动」时发生（一次提交 = 一条留痕事件） */
  const applyCandidate = (replacingId: string, recipeId: string): void => {
    setDishes((current) => current.map((dish) => (dish.recipeId === replacingId ? { ...dish, recipeId } : dish)));
    // 被换掉的那道菜进本会话排除集（spec §2.3）：不单靠「当前菜单」挡——草稿菜单会变，
    // 而且刚换掉的那道确实不在候选里没有任何意义（要换回来就直接去「加菜」里挑）。
    onExclude([replacingId]);
    setSwapping(null);
  };

  /**
   * 「换一整套」（spec §2.3）：重新生成整餐并**立即应用**（source='recommendation' → replace_set）。
   * 与单道换菜不同，它不走本地草稿：整餐重新生成本来就是「把这一套整套换掉」，
   * 而且它必须立刻落库才有可撤销的上一套（服务端从事件流推导上一套，草稿里没有留痕）。
   */
  const replaceSet = (): void => {
    setError(undefined);
    recommend.mutate(
      { diners },
      {
        onSuccess: (result) => {
          accept.mutate(
            {
              booking: {
                diners: result.diners.map((diner) => diner.memberId),
                dishes: result.dishes.map((dish) => dish.recipeId),
              },
              recommendation: result,
            },
            {
              onSuccess: () => setSwapping(null),
              onError: (cause) => setError(cause instanceof Error ? cause.message : '换一整套没换成功'),
            },
          );
        },
        onError: (cause) => setError(cause instanceof Error ? cause.message : '这一套没生成出来'),
      },
    );
  };

  const doUndoSet = (): void => {
    setError(undefined);
    undo.mutate(undefined, {
      onError: (cause) => setError(cause instanceof Error ? cause.message : '撤销失败'),
    });
  };

  const save = (): void => {
    setError(undefined);
    book.mutate(
      { slotId: slot.id, booking: { diners, dishes, source: 'manual' } },
      {
        onSuccess: () => navigate('/'),
        onError: (cause) => setError(cause instanceof Error ? cause.message : '保存失败'),
      },
    );
  };

  const doCancel = (): void => {
    setError(undefined);
    cancel.mutate(slot.id, {
      onSuccess: () => navigate('/'),
      onError: (cause) => setError(cause instanceof Error ? cause.message : '取消失败'),
    });
  };

  const decided = slot.status === 'decided';

  return (
    <div data-testid="slot-view" data-slot-id={slot.id}>
      <div className={`card ${styles.head}`}>
        <div className="spread">
          <div>
            <div className={styles.title}>
              {slot.date} · {slot.meal === 'lunch' ? '午餐' : '晚餐'}
            </div>
            <div className="sub">
              {/* 过了截止时刻的文案要跟屏幕上的按钮对上：`undo-set` 只由 decided && canUndoSet 决定，
                  没有可撤销的换套时页上只有「取消这一餐」，副标题就不该承诺一个不存在的按钮 */}
              {slot.editable
                ? decided
                  ? '已定，可改可取消'
                  : '未定'
                : decided
                  ? slot.canUndoSet
                    ? '这一餐已经过了：菜单改不了，但可以取消或撤销换套'
                    : '这一餐已经过了：菜单改不了，但可以取消'
                  : '这一餐已经过了，只能看'}
            </div>
          </div>
          <span className={decided ? 'badge ok' : 'badge'} data-testid="slot-status">
            {decided ? '已定' : '未定'}
          </span>
        </div>
      </div>

      {/* 用餐者名单：默认全员，可临时改（忌口、份量都按它算） */}
      <div className="card">
        <div className={styles.blockLabel}>这餐谁吃（忌口与份量按它算）</div>
        <div className={styles.diners} data-testid="diner-picker">
          {members.map((member) => {
            const on = diners.includes(member.id);
            const factor = factorOf.get(member.id);
            return (
              <button
                key={member.id}
                type="button"
                className={on ? `${styles.diner} ${styles.on}` : styles.diner}
                data-testid={`diner-${member.id}`}
                aria-pressed={on}
                onClick={() => toggleDiner(member.id)}
              >
                {member.emoji} {member.name}
                {on && factor ? (
                  <span className={styles.dinerFactor} data-testid={`diner-factor-${member.id}`}>
                    ×{factor.factor}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* 已选的菜 */}
      <div className="card">
        <div className={styles.blockLabel}>这一餐的菜（{dishes.length} 道）</div>
        {dishes.length === 0 ? (
          <div className="sub" data-testid="no-dishes">
            还没挑菜——下面点一下就加进来。
          </div>
        ) : (
          <div className={styles.chosen} data-testid="chosen-dishes">
            {dishes.map((dish) => {
              const recipe = byId.get(dish.recipeId);
              if (!recipe) return null;
              const dishPortion = portionOfDish(portion, dish.recipeId);
              return (
                <div key={dish.recipeId} className={styles.chosenItem} data-testid={`chosen-${dish.recipeId}`}>
                  <div className={styles.chosenRow}>
                    <span className={`${styles.kind} ${styles[recipe.kind]}`}>{KIND_LABEL[recipe.kind]}</span>
                    <span className={styles.chosenName}>{recipe.name}</span>
                    {/* 换菜（spec S2）：只对已定的菜给入口——未定时「挑一道」就是加菜，不需要先有再换 */}
                    {slot.editable && slot.menu ? (
                      <button
                        type="button"
                        className={styles.swap}
                        data-testid={`swap-${dish.recipeId}`}
                        aria-expanded={swapping === dish.recipeId}
                        onClick={() => setSwapping(swapping === dish.recipeId ? null : dish.recipeId)}
                      >
                        换
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={dish.keepLeftover ? `${styles.keep} ${styles.keepOn}` : styles.keep}
                      data-testid={`keep-${dish.recipeId}`}
                      aria-pressed={dish.keepLeftover}
                      onClick={() => toggleKeep(dish.recipeId)}
                    >
                      留量
                    </button>
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={`去掉 ${recipe.name}`}
                      data-testid={`remove-${dish.recipeId}`}
                      onClick={() => toggleDish(dish.recipeId)}
                    >
                      ✕
                    </button>
                  </div>
                  {/* 候选面板：只挂在正在被换的那道菜下面；草稿菜单与名单一起带过去 */}
                  {swapping === dish.recipeId ? (
                    <CandidateList
                      slotId={slot.id}
                      replacing={{ recipeId: dish.recipeId, name: recipe.name }}
                      diners={diners}
                      dishes={dishes.map((item) => item.recipeId)}
                      sessionExcludes={sessionExcludes}
                      onShown={onExclude}
                      onSwap={(candidate) => applyCandidate(dish.recipeId, candidate.recipeId)}
                      onClose={() => setSwapping(null)}
                    />
                  ) : null}
                  {/* 本餐生重：逐食材克数 + 合计（份量引擎算的，界面不自己乘） */}
                  {dishPortion ? (
                    <div className={styles.portion} data-testid={`portion-${dish.recipeId}`}>
                      {dishPortion.ingredients.map((item) => (
                        <span
                          key={item.ingredientId}
                          className={item.scaling === 'fixed' ? `${styles.grams} ${styles.fixed}` : styles.grams}
                          data-testid={`grams-${dish.recipeId}-${item.ingredientId}`}
                        >
                          {item.name} {item.grams} g
                        </span>
                      ))}
                      <span className={styles.total}>合计 {dishPortion.totalGrams} g</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 挑菜：按荤/素/汤分组 */}
      <div className="card">
        <div className={styles.blockLabel}>加菜（点一下加，再点一下去掉）</div>
        {(['meat', 'veg', 'soup_meat', 'soup_veg'] as const).map((kind) => {
          const group = pool.filter((recipe) => recipe.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className={styles.group}>
              <div className={styles.groupLabel}>{GROUP_LABEL[kind]}</div>
              <div className={styles.picker}>
                {group.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    className={chosen.has(recipe.id) ? `${styles.pick} ${styles.picked}` : styles.pick}
                    data-testid={`pick-${recipe.id}`}
                    aria-pressed={chosen.has(recipe.id)}
                    onClick={() => toggleDish(recipe.id)}
                  >
                    {recipe.name}
                    {recipe.status === 'draft' ? <span className={styles.tiny}>没做过</span> : null}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* 份量小结：这餐总共做多少（Σ系数 × 成人份基准；留量上浮要等 #22 的引用） */}
      {portion && dishes.length > 0 ? (
        <div className="card" data-testid="portion-summary">
          <div className={styles.blockLabel}>这餐的份量（生重）</div>
          <div className={styles.summaryLine}>
            {portion.diners.length} 人合计 ×{roundSum(portion.factorSum)}
            {portion.uplift !== 1 ? ` × 留量上浮 ${portion.uplift}` : ''}，共 {totalGrams(portion)} g
          </div>
          <div className="sub">
            大人按菜谱的成人份，小孩按出生年月现算年龄查 WS/T 554 分带；改上面的人或菜，这里立刻重算。
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="card" data-testid="slot-error-message">
          <span className={styles.error}>{error}</span>
        </div>
      ) : null}

      {/* 「换一整套」受 `slot.editable` 门控：它走 bookSlot（source='recommendation'），
          过了截止时刻服务端会 400——存量的「不应期」在服务端，界面不该放一个注定失败的口子进来；
          而「撤销换一整套」与「取消这一餐」是同一口径（撤销一条手滑的换套不需赶时间，
          domain/slots.ts 的 undoSet 刻意不查 hasMealPassed），所以它只由 decided && canUndoSet 决定。
          这个不对称是有意的：两者一个改菜单内容（要截止），一个只是退回上一套/取消（不要）。 */}
      {slot.editable || (decided && slot.canUndoSet) ? (
        <div className={styles.actions} data-testid="set-actions">
          {slot.editable ? (
            <button
              type="button"
              className="btn ghost block"
              data-testid="replace-set"
              disabled={recommend.isPending || accept.isPending}
              onClick={replaceSet}
            >
              {recommend.isPending || accept.isPending ? '正在换一整套…' : '🔄 换一整套'}
            </button>
          ) : null}
          {decided && slot.canUndoSet ? (
            <button
              type="button"
              className="btn ghost block"
              data-testid="undo-set"
              disabled={undo.isPending}
              onClick={doUndoSet}
            >
              {undo.isPending ? '撤销中…' : '↩ 撤销，回到上一套'}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className="btn block"
          data-testid="save-slot"
          disabled={!slot.editable || book.isPending || dishes.length === 0 || diners.length === 0}
          onClick={save}
        >
          {book.isPending ? '保存中…' : decided ? '保存改动' : '定下这一餐'}
        </button>
        {decided ? (
          <button
            type="button"
            className="btn ghost block"
            data-testid="cancel-slot"
            disabled={cancel.isPending}
            onClick={doCancel}
          >
            {cancel.isPending ? '取消中…' : '取消这一餐'}
          </button>
        ) : null}
      </div>

      {/* 留痕（append-only）：这一餐怎么一步步变成现在这样的 */}
      <div className="card">
        <div className={styles.blockLabel}>这一餐的留痕（{history.length} 条，只增不改）</div>
        {history.length === 0 ? (
          <div className="sub" data-testid="history-empty">
            还没定过，改完保存就会有第一条。
          </div>
        ) : (
          <ol className={styles.history} data-testid="slot-history">
            {history.map((event) => (
              <li key={event.seq} data-testid={`history-${event.type}`}>
                <span className={styles.eventType}>{EVENT_LABEL[event.type] ?? event.type}</span>{' '}
                <span className="sub">{eventAt(event.occurredAt)}</span>
                {event.dishes.length > 0 ? (
                  <div className="sub" data-testid={`history-${event.type}-dishes`}>
                    {event.dishes.map((dish) => dish.name).join('、')}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/**
 * 某道菜在本餐份量里的读数；份量还没回来（或这道菜刚加上、服务端还没算完）时给 undefined，
 * 界面就先不显示克数——显示上一次的旧数字比暂时空着更糟。
 */
function portionOfDish(portion: MenuPortion | undefined, recipeId: string) {
  return portion?.dishes.find((item) => item.recipeId === recipeId);
}

/** 一餐所有菜的合计生重 */
function totalGrams(portion: MenuPortion): number {
  return portion.dishes.reduce((sum, dish) => sum + dish.totalGrams, 0);
}

/** Σ系数展示到 3 位小数，抹掉浮点尾巴（1.7560000000000002 这种） */
function roundSum(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

const KIND_LABEL: Record<string, string> = { meat: '荤', veg: '素', soup_meat: '汤', soup_veg: '汤' };
const GROUP_LABEL: Record<string, string> = { meat: '荤菜', veg: '素菜', soup_meat: '荤汤', soup_veg: '素汤' };
const EVENT_LABEL: Record<string, string> = {
  decide: '预定',
  replace: '改餐',
  replace_set: '换一整套',
  cancel: '取消',
};

/**
 * 挑菜的顺序：先按荤素汤位、再按名字，顺序稳定、不随请求回来的次序漂移。
 * 退役的菜不上挑菜器（家里不再做；要吃先转正），草稿留着——它是外部补位池的菜（spec S6）。
 */
function sortForBooking(recipes: Recipe[]): Recipe[] {
  const order: Record<string, number> = { meat: 0, veg: 1, soup_meat: 2, soup_veg: 3 };
  return recipes
    .filter((recipe) => recipe.status !== 'retired')
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.name.localeCompare(b.name, 'zh'));
}

/** 事件的时刻：显示到分钟（家庭时区）——这是「家里什么时候定的」，不是技术时间戳 */
export function eventAt(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
