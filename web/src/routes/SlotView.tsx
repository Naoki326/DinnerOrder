import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useIdentity } from '../identity';
import { useMembers } from '../api/members';
import { useRecipes, type Recipe } from '../api/recipes';
import { usePortionPreview, type MenuPortion } from '../api/portion';
import { useBookLeftover, useBookSlot, useCancelSlot, useSlot, type DinerRef, type MealEvent, type MealSlot } from '../api/meals';
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
  // 编辑一份**旧菜单**时，上面的 `members` 只是「在用的家人」（已删的不在其中），而菜单里的
  // 用餐者名单是**当时的快照**，可能含已删的家人。两者的差集就是本票要处理的那个洞。
  // 这里再取一次同一个 `['members']` 查询（TanStack 会去重、共用缓存）：要的是它的
  // `isSuccess`——「名单到没到位」不能靠 `members.length > 0` 猜。
  const membersQuery = useMembers();
  const book = useBookSlot();
  const cancel = useCancelSlot();
  const leftover = useBookLeftover();
  const [error, setError] = useState<string | undefined>(undefined);

  // 本地草稿：编辑期间不动服务端，一次提交才是「菜单变了」的那个瞬间
  const [dinersDraft, setDinersDraft] = useState<string[] | null>(null);
  // 掌勺者草稿（本票：「随时可以改」——包括改**任意一餐**，不只未定的那餐）：
  // `undefined` = 还没动过，用下面的缺省值；一旦点选就固定成显式值（含 null = 不指定）。
  const [cookDraft, setCookDraft] = useState<string | null | undefined>(undefined);
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

  // 引用失效的通知（#22）：本餐是「吃剩的」引用方、而上一条取消事件就是联动退回——
  // 历史里「引用预定 → 取消」这个形状说明这一餐是因为被引用的那一餐没了才回到未定的。
  const revertedByReference = useMemo(() => {
    const last = history[history.length - 1];
    if (!last || last.type !== 'cancel') return false;
    return history.some((event) => event.leftoverSlotId !== null);
  }, [history]);

  // 首次定餐的默认用餐者是**全员**（总纲 §3）；家人列表可能晚于餐槽到位，所以默认值现算而不是初值快照
  const diners = dinersDraft ?? (slot.menu ? slot.menu.diners.map((diner) => diner.memberId) : members.map((m) => m.id));

  /**
   * 这一餐的掌勺者（本票）：
   *   * 已定餐槽用当时的快照（`slot.cook`）——家人后来被删也读得出当时的名字；**已定但没指定就
   *     保持未指定**（不回头编一个缺省值，否则打开编辑器再保存会静默改成别人）；
   *   * 未定餐槽用服务端下发的 `slot.cookDefault`（**按上一餐继承**，一路往前没有才回落 is_cook）
   *     ——缺省口径只服务端一处（“上一餐”是事件流知识，前端不一定看得见）。
   * 两者都拿不到就是 null（这一餐不指定）。
   */
  const defaultCookId = slot.status === 'decided' ? (slot.cook?.memberId ?? null) : (slot.cookDefault?.memberId ?? null);
  const cook = cookDraft === undefined ? defaultCookId : cookDraft;

  /**
   * 名单里**已不在家人列表**的那些人（含姓名与头像，来自菜单快照）。
   *
   * 为什么要有他们自己的一组 chip，而不是直接过滤掉：份量引擎对**显式名单**里的已删家人报
   * `unknown_member`（对「新写的名单里不该出现他」这个口径是对的），所以一份含 ghost 的旧菜单
   * 在编辑器里会同时坏掉「算份量」与「保存」两件事——而界面上原本没有那个人的chip可点。
   * 用户唯一的出路是放弃这一餐（`SlotView.tsx` 修复前的实际处境）。
   *
   * 现在的做法：家人名单**到位之后**（`membersQuery.isSuccess`）才分辨谁是 ghost——那之前不猜
   * （把「还没加载」当成「已删」会白打一次注定 400 的份量请求）；到位后仍不在名单里的，渲染成
   * 一张标了「已删」的 chip，用户可以自己点掉。**不静默剔除**：草稿一旦私下改写，界面上的份量
   * 就对不上菜单快照，而且「这份菜单里原来还有谁」这件事就被抹掉了——排除的可见性是本仓纪律。
   */
  const knownIds = useMemo(() => new Set(members.map((member) => member.id)), [members]);
  const ghosts = useMemo(
    () => (membersQuery.isSuccess ? (slot.menu?.diners ?? []).filter((diner) => !knownIds.has(diner.memberId)) : []),
    [membersQuery.isSuccess, slot.menu, knownIds],
  );
  // 掌勺者选项：在册家人 + （已定菜单快照里那位已被删的掌勺者）。
  // 已删的也要渲染出来（与 `ghosts` 的用餐者同一理由）：否则编辑一份旧菜单会把它默默改成别人。
  const cookGhost = slot.cook && !knownIds.has(slot.cook.memberId) ? slot.cook : undefined;
  const cleanup = useMemo(() => removeGhosts(diners, ghosts), [diners, ghosts]);
  /**
   * 「谁还在家人列表里」拿到之前，已定菜单的名单先别往外发（见 `usePortionPreview` 的 `ready`）：
   * 那一段空窗里发出去的请求会把快照里的已删家人当成未知成员，白得一个 400。
   * 这份名单**读不回来**时（`isError`）份量请求就永远不发——所以份量区必须把这件事说出来
   * （下面 `portion-error` 那块的分支），否则就是一片静默空白。
   */
  const rosterKnown = membersQuery.isSuccess;
  /** 还在草稿名单里的 ghost：提示文案与保存拦截都看它（全被点掉后就不再拦了） */
  const draftGhosts = useMemo(() => ghosts.filter((ghost) => diners.includes(ghost.memberId)), [ghosts, diners]);
  /**
   * 家人名单读不回来时份量区那句说明。两种失败要分开说：**首屏就没读到**（屏幕上一位家人也没有），
   * 与**只是这一次刷新失败**（缓存里还有上次的名单，人还渲染在屏幕上）——后者说「没刷新回来」，
   * 否则那句「名单没读回来」与眼前那排家人 chip 自相矛盾。两种情况下 `isSuccess` 都为假，
   * 份量请求都发不出去（`ready` 门控），所以都必须有一句话，不能静默空白。
   */
  const rosterErrorMessage = membersQuery.isRefetchError
    ? '家人列表这次没刷新回来——份量算不出来'
    : '家人列表没读回来——份量算不出来';
  /**
   * 名单里还留着已删的家人时，一切**会落库**的动作先停在本地并说清下一步。
   * 不去打一个注定 400 的请求（服务端只报一个 memberId，那一串 id 对家人没有意义），
   * 但也不静默把 ghost 从名单里抹掉——草稿是用户的东西，点掉那个 chip 才是他按下的一步。
   */
  const ghostBlockMessage = (): string | undefined =>
    draftGhosts.length === 0
      ? undefined
      : `${draftGhosts.map((ghost) => ghost.name).join('、')} 已不在家人列表里（这份名单是定这一餐时的快照）。` +
        '点一下上面标了「已删」的名字把他从这一餐移除，再继续。';

  // 份量随草稿名单/菜品即时重算（服务端算，前端只显示）。带上餐槽 id：留量上浮要问
  // 「这一餐有没有被『吃剩的』引用」（#22）。
  //
  // 算的时候先剔掉已知的 ghost：份量引擎对显式名单里的已删家人报 `unknown_member`，带着 ghost 打
  // 过去就是一个注定 400 的请求——份量区整个空白，用户连别的菜都改不了。剔掉是**纯展示口径**
  // （克数少一个人，屏幕上那张「已删」chip 同时在说为什么少），保存时提交的仍是上面那个 `diners`：
  // 草稿不被偷改，用户点掉 chip 之前，保存会被 `ghostBlockMessage` 挡在本地并给出一句人话。
  const portionQuery = usePortionPreview(cleanup, dishes, slot.id, { ready: rosterKnown });
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

  /** 一键清掉全部「已删家人」——一个按钮比让用户在几个 chip 之间逐个点更省事，且动作完全一样 */
  const dropGhosts = (): void => {
    setDinersDraft(cleanup);
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
    const blocked = ghostBlockMessage();
    if (blocked !== undefined) {
      setError(blocked);
      return;
    }
    recommend.mutate(
      { diners },
      {
        onSuccess: (result) => {
          accept.mutate(
            {
              booking: {
                diners: result.diners.map((diner) => diner.memberId),
                dishes: result.dishes.map((dish) => dish.recipeId),
                // 换一整套不改掌勺者：把当前这一餐的草稿值原样带上（accept 是整份提交）
                cook,
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
    const blocked = ghostBlockMessage();
    if (blocked !== undefined) {
      setError(blocked);
      return;
    }
    book.mutate(
      { slotId: slot.id, booking: { diners, dishes, cook, source: 'manual' } },
      {
        onSuccess: () => navigate('/'),
        onError: (cause) => setError(cause instanceof Error ? cause.message : '保存失败'),
      },
    );
  };

  const doCancel = (): void => {
    setError(undefined);
    cancel.mutate(slot.id, {
      onSuccess: (result) => {
        // 取消被「吃剩的」引用的那一餐时，服务端把引用方一起退回未定（#22）。这件事必须在
        // 首页说清楚（这一页马上要离开），所以经路由 state 带过去——否则家人只会看到晚餐
        // 莫名其妙变回未定。
        navigate('/', { state: result.released.length > 0 ? { released: result.released } : null });
      },
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

      {/* 「吃剩的」（#22、总纲 §2.6）：晚餐可以预定成吃同日午餐剩的。
          入口的可用性由服务端下发（`leftoverSource`，午餐得已定且有留量菜）；
          已定成「吃剩的」的那一餐把这一层说出来——它没有自己的菜单快照，菜是从午餐现推导的。 */}
      {slot.menu?.leftoverSlotId ? (
        <div className="card" data-testid="leftover-banner">
          <div className={styles.blockLabel}>🌙 这一餐吃中午剩的</div>
          <div className="sub">
            引用 {slot.menu.leftoverSlotId.slice(0, 10)} 的午餐：这边不另采购，菜是从午餐标了留量的那几道
            现推导的（午餐改了菜，这一餐跟着变）。
          </div>
        </div>
      ) : slot.editable && slot.leftoverSource && !decided ? (
        <div className="card" data-testid="leftover-entry">
          <div className={styles.blockLabel}>这一餐要不要吃中午剩的？</div>
          <button
            type="button"
            className="btn ghost block"
            data-testid="book-leftover"
            onClick={() => {
              setError(undefined);
              leftover.mutate(
                { slotId: slot.id, leftoverOf: slot.leftoverSource!.slotId, diners, cook },
                { onError: (cause) => setError(cause instanceof Error ? cause.message : '预定「吃剩的」失败') },
              );
            }}
            disabled={leftover.isPending}
          >
            {leftover.isPending
              ? '预定中…'
              : `🌙 吃中午剩的（${slot.leftoverSource.dishes.map((dish) => dish.name).join('、')}）`}
          </button>
          <div className="sub" style={{ marginTop: 8 }}>
            选它就不另采购；中午那几道多做的那份已按留量上浮算进去。
          </div>
        </div>
      ) : null}

      {/* 引用没了（#22）：这一餐是被联动画回来的，得说清原因，不能默默变回未定 */}
      {slot.status === 'undecided' && revertedByReference ? (
        <div className="card" data-testid="leftover-reverted-notice">
          <span className={styles.error}>
            中午那餐取消了，这一餐也不会再做 —— 已自动退回未定（留痕里看得到）。
          </span>
        </div>
      ) : null}

      {/* 掌勺者（本票，按餐指定）：厨房里这一餐谁做。它是菜单信息的一部分（餐后回顾的读者、
          买菜清单的读者），所以放在“谁吃”旁边；改任意一餐都走这里（包括已定餐槽）。 */}
      <div className="card" data-testid="cook-picker">
        <div className={styles.blockLabel}>这一餐谁掌勺（餐后回顾与买菜清单的读者）</div>
        <div className={styles.diners}>
          {members.map((member) => {
            const on = cook === member.id;
            return (
              <button
                key={member.id}
                type="button"
                className={on ? `${styles.diner} ${styles.on}` : styles.diner}
                data-testid={`cook-${member.id}`}
                aria-pressed={on}
                onClick={() => setCookDraft(on ? null : member.id)}
              >
                {member.emoji} {member.name}
              </button>
            );
          })}
          {/* 快照里那位已被删的掌勺者（软删除）：照旧显示当时的名字，可点掉或留着 */}
          {cookGhost ? (
            <button
              type="button"
              className={
                cook === cookGhost.memberId
                  ? `${styles.diner} ${styles.on} ${styles.dinerGhost}`
                  : `${styles.diner} ${styles.dinerGhost}`
              }
              data-testid={`cook-ghost-${cookGhost.memberId}`}
              aria-pressed={cook === cookGhost.memberId}
              onClick={() => setCookDraft(cook === cookGhost.memberId ? null : cookGhost.memberId)}
            >
              {cookGhost.emoji} {cookGhost.name}
              <span className={styles.ghostTag}>已删</span>
            </button>
          ) : null}
        </div>
        <div className="sub" style={{ marginTop: 8 }} data-testid="cook-hint">
          {cook
            ? '点一下别人就换过去；再点一下当前这位 = 这一餐不指定。'
            : '未指定 —— 保存后按“家里通常做菜的那位”缺省；点一位就钉死这一餐的掌勺者。'}
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
          {/* 已经不在家人列表里、却还留在这份菜单快照里的用餐者（软删除的家人）。
              渲染出来才能点掉——否则这份菜单既算不出份量也存不回去，界面上却没有路可走。 */}
          {ghosts.map((ghost) => {
            const on = diners.includes(ghost.memberId);
            return (
              <button
                key={ghost.memberId}
                type="button"
                className={on ? `${styles.diner} ${styles.on} ${styles.dinerGhost}` : `${styles.diner} ${styles.dinerGhost}`}
                data-testid={`diner-ghost-${ghost.memberId}`}
                aria-pressed={on}
                onClick={() => toggleDiner(ghost.memberId)}
              >
                {ghost.emoji} {ghost.name}
                <span className={styles.ghostTag}>已删</span>
              </button>
            );
          })}
        </div>
        {ghosts.length > 0 ? (
          <div className={styles.ghostNote} data-testid="diner-ghost-note">
            <span>
              {ghosts.map((ghost) => ghost.name).join('、')} 已不在家人列表里（名单是定这一餐时的快照）。
              {draftGhosts.length > 0
                ? cleanup.length > 0
                  ? '点一下他的名字把他从这一餐移除——在那之前，保存与换一整套都会先拦住。'
                  : '点一下他的名字把他从这一餐移除，再从上面在册的家人里点一位——这一餐至少要有一位用餐者才能保存。'
                : diners.length === 0
                  ? '已经从这一餐移除了。名单现在是空的——从上面在册的家人里点一位，才能保存。'
                  : '已经从这一餐的草稿里移除了，保存后这份菜单就不再包含他（留痕里看得到这次改动）。'}
            </span>
            {draftGhosts.length > 0 ? (
              <button type="button" className="btn ghost" data-testid="diner-ghost-remove-all" onClick={dropGhosts}>
                移除已删的家人
              </button>
            ) : null}
          </div>
        ) : null}
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
                      // 候选的忌口过滤用**剔掉 ghost 后**的名单：这与上面份量预览同一口径，
                      // 也是保存时真正会落库的那份名单（候选接口对已删家人同样报 unknown_member）。
                      diners={cleanup}
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

      {/* 份量小结：这餐总共做多少（Σ系数 × 成人份基准；留量上浮要等 #22 的引用）。
          两件「算不出来」都要有话说（本仓纪律：异常原因看得见）：
            * `membersQuery.isError`：家人列表读不回来 → `ready` 门控让份量请求根本发不出去，
              只等 `portionQuery.isError` 就会是一片静默空白——所以这一支自己说一句人话；
            * `portionQuery.isError`：份量接口报错 → 把服务端/请求层那句原样报出来。 */}
      {membersQuery.isError || portionQuery.isError ? (
        <div className="card" data-testid="portion-error">
          <div className={styles.error}>
            {membersQuery.isError
              ? rosterErrorMessage
              : portionQuery.error instanceof Error
                ? portionQuery.error.message
                : '份量没算出来'}
          </div>
          {membersQuery.isError ? (
            <div className="sub" style={{ marginTop: 6 }}>
              份量按用餐者名单折算，名单读不回来就没法算。检查一下网络或服务是不是停了，刷新本页再试。
            </div>
          ) : draftGhosts.length > 0 ? (
            <div className="sub" style={{ marginTop: 6 }}>
              名单里还有已删的家人——点掉上面标了「已删」的名字，份量就会重新算。
            </div>
          ) : null}
        </div>
      ) : null}
      {portion && !membersQuery.isError && dishes.length > 0 ? (
        <div className="card" data-testid="portion-summary">
          <div className={styles.blockLabel}>这餐的份量（生重）</div>
          <div className={styles.summaryLine}>
            {portion.diners.length} 人合计 ×{roundSum(portion.factorSum)}
            {/* 倍数从 `portion.uplift` 动态读（#22 台账：不再硬编码 ×1.5）。它是**实际生效**的
                那个值（留量标记 ∧ 有效引用），为 1 时不标——标一个没兑现的倍数比不标更糟。 */}
            {portion.uplift !== 1 ? ` × 留量上浮 ${portion.uplift}` : ''}，共 {totalGrams(portion)} g
          </div>
          {/* 读数旁的口径注记：`portion.diners.length` 是剔掉 ghost 之后的人数，而选择器里
              ghost chip 还是 `aria-pressed=true`（看起来在名单里）。不点 chip 的人也要看得出
              「这个数字里没有已删的家人」——`diner-ghost-note` 讲怎么处理，这里只讲数字是什么。 */}
          {draftGhosts.length > 0 ? (
            <div className={styles.portionGhostNote} data-testid="portion-ghost-note">
              ⚠️ 已删的家人（{draftGhosts.map((ghost) => ghost.name).join('、')}）没算进份量：人数与克数只按还在册的家人算
            </div>
          ) : null}
          <div className="sub">
            大人按菜谱的成人份，小孩按出生年月现算年龄查 WS/T 554 分带；改上面在册的家人或菜，这里立刻重算。
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
 * 从草稿名单里剔掉已知的「已删家人」，供**份量预览与候选名单**使用；原始草稿不动，
 * 调用方拿 `draftGhosts` 决定要不要在界面上说一句、要不要拦住保存。
 *
 * 只处理 `ghosts` 里点名的那几个：不在 `ghosts` 里、也不在 `members` 里的 id（家人列表还没
 * 到位、或名单里本就混进了一个不明的 id）原样留下——那种情况下界面没有可解释的信息，
 * 交给服务端的 `unknown_member` 报出来比静默剔除更诚实。
 */
function removeGhosts(diners: string[], ghosts: DinerRef[]): string[] {
  if (ghosts.length === 0) return diners;
  const ghostIds = new Set(ghosts.map((ghost) => ghost.memberId));
  return diners.filter((id) => !ghostIds.has(id));
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
