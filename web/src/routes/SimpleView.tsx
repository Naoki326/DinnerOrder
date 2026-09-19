import { useState } from 'react';
import { Link } from 'react-router';
import { useIdentity } from '../identity';
import { useBookLeftover, useCancelSlot, useSlots, type SlotWithPortion } from '../api/meals';
import {
  useAcceptRecommendation,
  useRecommendation,
  type MealRecommendation,
} from '../api/recommendations';
import { usePortionPreview } from '../api/portion';
import { CandidateList } from '../components/CandidateList';
import { dayLabel } from './HomeView';
import styles from './SimpleView.module.css';

/**
 * C 视图：长辈小孩极简（总纲 §2.10、原型变体 C）。
 *
 * 一屏一件事、大按钮、两步向导：主界面只问「这一顿定不定」，定了进「谁吃 → 吃这些」两步，
 * 每道菜一张大卡（菜名 + 克数 + 「不喜欢？换一个」），最后「✓ 就这么吃」。
 *
 * 与 A/B 的语义完全一致，只是摆法不同：
 *   * 「给我们推荐」还是**显式触发**（总纲 §2.2），并且走同一条 `/recommendation`；
 *   * 「换一个」走同一个 `/candidates` + 同一个 `CandidateList`（含会话排除：被换掉的 + 已出示过的）；
 *   * 「整套都换」与「还是刚才那套」是 A 上「换一整套 / 撤销」的同一条草稿语义（草稿不落库，
 *     所以「上一套」只能在前端留住——与 `HomeView` 的草稿撤销同一实现，不是另造一套服务端机制）；
 *   * 「就这么吃」走同一条 `PUT /slots/:id`（source='recommendation'，带 LLM 元数据进留痕）。
 *
 * 也留一条「自己挑菜」进**同一个**定餐编辑器（`/slot/:id`）：三套视图共用一套操作，
 * 才不会出现「C 里不能改用餐者」这种语义缺口。
 *
 * 「吃剩的」（#22、总纲 §2.10 的三视图语义一致）：与 A 的大卡同一语义、同一条 `useBookLeftover`，
 * 只是换成这一屏的形态——未定时一个大按钮；已定成「吃剩的」时一句大字说明（等于 A 的 `hero-leftover`）。
 * 入口可用性由服务端下发（`slot.leftoverSource`），这一屏不自己拼「晚餐 + 同日午餐已定」的判断：
 * 它连今天午餐定没定都不一定看得见（过了截止时刻的餐槽不在列表里）。
 * 取消：这一屏没有别的取消路径（已定的餐本来就不在这一屏出现），所以「不吃剩的了」跟着那句说明一起给
 * ——与 A 的 `cancel-leftover-button` 同一语义、同一个位置，不是为对称另造的常驻入口。
 * 「回顾」不用在这里补：三视图共用底部 `TabBar` 的 `/review`。
 */
export function SimpleView() {
  const slotsQuery = useSlots(3);
  const { members } = useIdentity();
  const bookLeftover = useBookLeftover();
  const cancel = useCancelSlot();
  const [wizard, setWizard] = useState(false);
  // 刚在本屏定下的那一餐（回声）：定完它就从「未定」变成「已定」，而这一屏只显示未定的餐——
  // 不留住它，家人按完大按钮就看不到自己做了什么（A 有下面的餐卡列表，C 没有，只能自己回声）。
  const [booked, setBooked] = useState<SlotWithPortion | null>(null);
  // 说明被收掉过（「👍 好」或取消）：不能再由「这几天全定完」那一路弹回来，否则是个关不掉的框。
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const slots = slotsQuery.data?.slots ?? [];
  const today = slotsQuery.data?.today;
  // 一屏一事：只关心最近那一件**还没定**的事（已定的餐不在这里出现——想看就去 B 的日程）
  const next = slots.find((slot) => slot.status === 'undecided');

  const isLeftover = (slot: SlotWithPortion): boolean => slot.menu !== null && slot.menu.leftoverSlotId !== null;
  const resumed = booked === null ? undefined : slots.find((slot) => slot.id === booked.id);
  // 「查询还没落定」必须用查询自己的信号判：`status` 分不出「缓存里还是敲之前的旧未定」与
  // 「已经拉到真值、真的未定了」——只看 status 会让前者闪回未定（见 `keepEcho` 的注释）。
  // `isPaused` 也算没落定：刚定完就断网时，那次重拉会暂停在那里，缓存里仍是旧读数。
  const refetchPending = slotsQuery.isFetching || slotsQuery.isPaused;
  const echo = booked === null ? undefined : keepEcho(booked, resumed, refetchPending);

  /**
   * 「已定成吃剩的」的那一餐（等于 A 大卡的 `hero-leftover`）什么时候上屏：
   *   * 刚在本屏定下的那一餐（回声）—— C 没有列表能报信，不回一声家人不知道成没成；
   *   * 或这几天**全定完**（没有未定的餐了）且窗口里第一张就是「吃剩的」那一餐（这需要今天午餐
   *     已过截止 —— 否则 `slots[0]` 永远是午餐、不可能是留量）—— 与 A 同一取法（A 全定完时卡
   *     也是 `list[0]`），刷新/换台手机进来也看得见。
   * 与 A 同一取舍：还有未定的餐时不让说明抢屏（那一屏只问「这一顿定不定」，A 的大卡也优先给未定的
   * 那一餐）。回收掉的说明不会自己弹回来（`dismissed`）。
   */
  const first = slots[0];
  const leftoverSlot =
    echo ??
    (!dismissed && next === undefined && first !== undefined && isLeftover(first) ? first : undefined);

  if (slotsQuery.isPending) {
    return (
      <div className="card sub" data-testid="simple-view" data-state="loading">
        读取中…
      </div>
    );
  }
  if (slotsQuery.isError) {
    return (
      <div className="card" data-testid="simple-view" data-state="error">
        <b>今日餐桌没读回来</b>
        <div className="sub" style={{ marginTop: 6 }}>
          检查一下网络或服务是不是停了。
        </div>
      </div>
    );
  }

  if (wizard && next) {
    return (
      <div data-testid="simple-view" data-state="wizard">
        <SimpleWizard key={next.id} slot={next} today={today} onDone={() => setWizard(false)} />
      </div>
    );
  }

  const doBookLeftover = (slot: SlotWithPortion): void => {
    const source = slot.leftoverSource;
    if (!source) return;
    setError(undefined);
    bookLeftover.mutate(
      {
        slotId: slot.id,
        // 被引用那一餐由服务端下发（同日午餐），前端不自己拼「晚餐 + 同日午餐已定」的判断
        leftoverOf: source.slotId,
        // 与 A 的大卡、编辑器的同一条口径：未定的餐槽没有名单快照，默认全员（总纲 §3）
        diners: slot.menu?.diners.map((diner) => diner.memberId) ?? members.map((member) => member.id),
      },
      {
        onSuccess: (saved) => setBooked(saved),
        onError: (cause) => setError(cause instanceof Error ? cause.message : '预定「吃剩的」失败'),
      },
    );
  };

  return (
    <div className={styles.wrap} data-testid="simple-view">
      {leftoverSlot ? (
        <>
          <div className={styles.emoji} aria-hidden="true">
            🌙
          </div>
          <div className={styles.big} data-testid="simple-leftover-note">
            {dayLabel(leftoverSlot, today)}
            {leftoverSlot.meal === 'lunch' ? '午餐' : '晚餐'}
            <br />
            吃中午剩的
          </div>
          <div className={styles.leftover}>🌙 {(leftoverSlot.menu?.dishes ?? []).map((dish) => dish.name).join('、')}</div>
          <div className="sub">不另采购 —— 吃的是中午多做的那几道，做菜量已按留量上浮。</div>
          {/* 刚定下：给一个「这一步做完了」的大按钮（与向导里的「就这么吃」同一形态） */}
          {booked ? (
            <button
              type="button"
              className={styles.main}
              data-testid="simple-leftover-done"
              onClick={() => {
                setBooked(null);
                setDismissed(true);
              }}
            >
              👍 好
            </button>
          ) : null}
          {/* 取消：这一屏没有别的取消路径（已定的餐不出现在这里），所以它就是 C 的取消入口
              ——与 A 的 `cancel-leftover-button` 同一语义、同一种大按钮 */}
          <button
            type="button"
            className={styles.sec}
            data-testid="simple-cancel-leftover"
            disabled={cancel.isPending}
            onClick={() => {
              setError(undefined);
              cancel.mutate(leftoverSlot.id, {
                onSuccess: () => {
                  setBooked(null);
                  setDismissed(true);
                },
                onError: (cause) => setError(cause instanceof Error ? cause.message : '取消失败'),
              });
            }}
          >
            {cancel.isPending ? '取消中…' : '不吃剩的了'}
          </button>
        </>
      ) : next ? (
        <>
          <div className={styles.emoji} aria-hidden="true">
            🍽️
          </div>
          <div className={styles.big}>
            {dayLabel(next, today)}
            {next.meal === 'lunch' ? '午餐' : '晚餐'}
            <br />
            还没定
          </div>
          <button type="button" className={styles.main} data-testid="simple-recommend" onClick={() => setWizard(true)}>
            ✨ 给我们推荐
          </button>
          {/* 「吃剩的」（#22）：只在服务端下发了来源（同日午餐已定且有留量菜）时给入口，
              已定的餐槽不再重复给（要改就去编辑器）——与 A 的 `book-leftover-button` 同一显示条件 */}
          {next.leftoverSource ? (
            <button
              type="button"
              className={styles.sec}
              data-testid="simple-leftover"
              disabled={bookLeftover.isPending}
              onClick={() => doBookLeftover(next)}
            >
              {bookLeftover.isPending
                ? '预定中…'
                : `🌙 吃中午剩的（${next.leftoverSource.dishes.map((dish) => dish.name).join('、')}）`}
            </button>
          ) : null}
          <Link className={styles.sec} to={`/slot/${next.id}`} data-testid="simple-manual">
            ✋ 自己挑菜
          </Link>
          <div className="sub" style={{ marginTop: 16 }}>
            「给我们推荐」会先问这一顿谁吃，再配一桌菜；不爱吃的可以单换，也可以整套重来。
          </div>
        </>
      ) : (
        <>
          <div className={styles.emoji} aria-hidden="true">
            😌
          </div>
          <div className={styles.big}>这几天都定好啦</div>
          <div className="sub">没定的餐 app 不打扰 —— 可能在外吃、吃剩的。</div>
        </>
      )}
      {error ? (
        <div className="card" data-testid="simple-leftover-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 回声该显示哪一份读数（刚在本屏定下的那一餐）。三段语义，按「服务端是否已经给出结论」分：
 *   * 列表里**没有**它 → 用落库响应顶着（列表窗口里本该看得到刚定的这一餐；真没有时也不能闪）；
 *   * 列表里那一份**已定** → 服务端已经给出结论：还是留量就用它（菜名从被引用那一餐现推导，
 *     午餐改了菜这里跟着变）；不是留量了（午餐被改回普通菜单…）就丢掉回声；
 *   * 列表里那一份**还是未定** → 还要分「还没拉到」与「拉到了且真是未定」：
 *       - `refetchPending`（`invalidateQueries` 触发的重拉还在飞，或断网被暂停）→ 缓存里是敲之前
 *         的**旧**读数，先用落库响应顶住：否则家人刚按完大按钮，屏上会闪回「还没定」那一步
 *         （按钮又冒出来）。C 没有别的反馈渠道，闪一下比滞后更难理解。
 *       - 否则（重拉已经落定）→ 服务端确实把这一餐联动画回了未定（比如被引用的午餐被取消），
 *         这是**真值**：丢掉回声。留着它会让 C 显示过期的留量说明 + `simple-cancel-leftover`，
 *         点下去只会拿到 `not_decided`，而 A 此刻显示的是未定卡——两视图不一致。
 *
 * 为什么不能简单看 `status`：`status !== 'decided'` 同时落在上面那两种读数上（重拉在飞时缓存里
 * 仍是旧的 `undecided`，拉到之后才是真的 `undecided`），只有查询自己的「还没落定」信号分得开。
 * （与 A 同一局限：别人在另一台设备上取消午餐、而本页查询未重拉时，两边都会先显示旧的一份。）
 */
function keepEcho(
  booked: SlotWithPortion,
  resumed: SlotWithPortion | undefined,
  refetchPending: boolean,
): SlotWithPortion | undefined {
  if (resumed === undefined) return booked;
  if (resumed.status === 'decided') {
    return resumed.menu !== null && resumed.menu.leftoverSlotId !== null ? resumed : undefined;
  }
  return refetchPending ? booked : undefined;
}

/** 两步向导：1 谁吃（名单）→ 2 吃这些（每道可换、整套可换可撤销、就这么吃） */
function SimpleWizard({
  slot,
  today,
  onDone,
}: {
  slot: SlotWithPortion;
  today: string | undefined;
  onDone: () => void;
}) {
  const { members } = useIdentity();
  const [step, setStep] = useState<1 | 2>(1);
  const [dinersDraft, setDinersDraft] = useState<string[] | null>(null);
  const [recommendation, setRecommendation] = useState<MealRecommendation | null>(null);
  // 「整套都换」前那一份草稿：草稿不落库（总纲 §4），所以「还是刚才那套」只能在前端留住。
  // 与 `HomeView` 的草稿撤销是同一口径（只退一步），不是另造一套服务端机制。
  //
  // 这一小块草稿状态机（`previous` / `request` / `undoSet` / 接受后清空）与 A 视图 `HomeView.tsx`
  // 的 `previousRecommendation` / `request` / `undoRecommendation` / `acceptRecommendation` 同形。
  // **不提取共享 hook**：A 那边同批是 #20（反馈）与 #22（留量）的改动面，抽出来会在集成期
  // 制造跨票冲突。口径统一先靠这几行标注守住（本轮修复**不动 `HomeView.tsx`**），
  // 合并口径的收口留待后续工单（已上报调度层登记台账）。
  const [previous, setPrevious] = useState<MealRecommendation | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  // 本换菜会话的排除集（被换掉的 + 已出示过的候选）：换整套/撤销后整份草稿换代 → 清空
  // （与 A 上换一整套重挂载推荐面板同一纪律，spec §2.3 的累积排除只限一个草稿会话内）
  const [sessionExcludes, setSessionExcludes] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const recommend = useRecommendation(slot.id);
  const accept = useAcceptRecommendation(slot.id);

  // 默认用餐者全员（总纲 §3）；家人列表晚于餐槽到位，所以默认值现算而不是初值快照
  const diners = dinersDraft ?? members.map((member) => member.id);

  // 第二步的克数：与编辑器同一个份量接口（份量规则只有服务端一份，界面不自己乘）
  const draftDishes = recommendation?.dishes.map((dish) => ({ recipeId: dish.recipeId, keepLeftover: false })) ?? [];
  const portionQuery = usePortionPreview(diners, draftDishes);

  /**
   * 拉一份新草稿。`keepPrevious` 只有「整套都换」要：它在换之前把眼前这份记成可撤销的「上一套」
   * （首次推荐没有可退的东西）；选项对象而不是布尔位置参数，读调用点能直接看出是哪一种。
   */
  const request = ({ keepPrevious = false }: { keepPrevious?: boolean } = {}): void => {
    setError(undefined);
    recommend.mutate(
      { diners },
      {
        onSuccess: (result) => {
          if (keepPrevious) setPrevious(recommendation);
          setRecommendation(result);
          // 整份草稿换代 = 新会话：会话排除集跟着清空（与 A 上换一整套同一纪律）
          setSessionExcludes([]);
          setSwapping(null);
          setStep(2);
        },
        onError: (cause) => setError(cause instanceof Error ? cause.message : '这一套没配出来'),
      },
    );
  };

  /** 撤销「整套都换」：只退一步（与 A 的撤销同一口径，不做 ping-pong） */
  const undoSet = (): void => {
    if (!previous) return;
    setRecommendation(previous);
    setPrevious(null);
    setSessionExcludes([]);
    setSwapping(null);
  };

  const confirm = (): void => {
    if (!recommendation) return;
    setError(undefined);
    accept.mutate(
      {
        booking: {
          diners: recommendation.diners.map((diner) => diner.memberId),
          dishes: recommendation.dishes.map((dish) => dish.recipeId),
        },
        recommendation,
      },
      {
        onSuccess: () => {
          setRecommendation(null);
          setPrevious(null);
          onDone();
        },
        onError: (cause) => setError(cause instanceof Error ? cause.message : '没保存上'),
      },
    );
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.dots} aria-hidden="true">
        {[1, 2].map((index) => (
          <i key={index} className={step >= index ? `${styles.dot} ${styles.dotOn}` : styles.dot} />
        ))}
      </div>

      {step === 1 ? (
        <div data-testid="simple-step-diners">
          <div className={styles.big}>谁吃？</div>
          <div className={styles.dinerRow}>
            {members.map((member) => {
              const on = diners.includes(member.id);
              return (
                <div key={member.id} className={styles.dinerCell}>
                  <button
                    type="button"
                    className={on ? `${styles.avatar} ${styles.avatarOn}` : styles.avatar}
                    data-testid={`simple-diner-${member.id}`}
                    aria-pressed={on}
                    onClick={() =>
                      setDinersDraft(
                        on ? diners.filter((id) => id !== member.id) : [...diners, member.id],
                      )
                    }
                  >
                    {member.emoji}
                  </button>
                  <div className="sub">{member.name}</div>
                </div>
              );
            })}
          </div>
          <div className="sub" style={{ marginBottom: 12 }}>
            {members
              .filter((member) => diners.includes(member.id))
              .map((member) => member.name)
              .join('、')}{' '}
            · {diners.length} 人
          </div>
          <button
            type="button"
            className={styles.main}
            data-testid="simple-next"
            disabled={diners.length === 0 || recommend.isPending}
            onClick={() => request()}
          >
            {recommend.isPending ? '正在配菜…' : '下一步 ›'}
          </button>
          <button type="button" className={styles.sec} onClick={() => onDone()}>
            先等等
          </button>
        </div>
      ) : null}

      {step === 2 && recommendation ? (
        <div data-testid="simple-step-review">
          <div className={styles.big}>
            {dayLabel(slot, today)}
            {slot.meal === 'lunch' ? '午餐' : '晚餐'}
            <br />
            吃这些
          </div>

          {recommendation.llm.format === 'rules_only' ? (
            <div className="badge warn" data-testid="simple-degraded">
              简化推荐
            </div>
          ) : null}

          <div className={styles.cards}>
            {recommendation.dishes.map((dish) => {
              const portion = portionQuery.data?.dishes.find((item) => item.recipeId === dish.recipeId);
              return (
                <div key={dish.recipeId} className={styles.card} data-testid={`simple-dish-${dish.recipeId}`}>
                  <div className="spread">
                    <b className={styles.dishName}>{dish.name}</b>
                    <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
                  </div>
                  {dish.origin === 'external' ? <span className="badge">没做过</span> : null}
                  {dish.reason ? <div className="sub">{dish.reason}</div> : null}
                  {portion ? (
                    <div className={styles.grams}>
                      {portion.ingredients.map((item) => `${item.name} ${item.grams}g`).join(' · ')} · 共{' '}
                      {portion.totalGrams}g
                    </div>
                  ) : null}

                  {swapping === dish.recipeId ? (
                    <CandidateList
                      slotId={slot.id}
                      replacing={{ recipeId: dish.recipeId, name: dish.name }}
                      // 用**这份草稿的用餐者快照**而不是当前勾选：候选的忌口过滤必须与眼前这套菜对齐
                      diners={recommendation.diners.map((diner) => diner.memberId)}
                      dishes={recommendation.dishes.map((item) => item.recipeId)}
                      sessionExcludes={sessionExcludes}
                      onShown={(ids) =>
                        setSessionExcludes((current) => [...new Set([...current, ...ids])])
                      }
                      onSwap={(candidate) => {
                        setSessionExcludes((current) => [...new Set([...current, dish.recipeId])]);
                        setRecommendation((current) =>
                          current
                            ? {
                                ...current,
                                dishes: current.dishes.map((item) =>
                                  item.recipeId === dish.recipeId
                                    ? {
                                        recipeId: candidate.recipeId,
                                        name: candidate.name,
                                        kind: candidate.kind,
                                        origin: candidate.origin,
                                        reason: candidate.reason,
                                      }
                                    : item,
                                ),
                              }
                            : current,
                        );
                        setSwapping(null);
                      }}
                      onClose={() => setSwapping(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className={styles.secSmall}
                      data-testid={`simple-swap-${dish.recipeId}`}
                      onClick={() => setSwapping(dish.recipeId)}
                    >
                      不喜欢？换一个
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className={styles.sec}
            data-testid="simple-replace-set"
            disabled={recommend.isPending}
            onClick={() => request({ keepPrevious: true })}
          >
            🔄 整套都换
          </button>
          {previous ? (
            <button type="button" className={styles.sec} data-testid="simple-undo-set" onClick={undoSet}>
              ↩ 还是刚才那套
            </button>
          ) : null}
          <button
            type="button"
            className={styles.main}
            data-testid="simple-accept"
            disabled={accept.isPending}
            onClick={confirm}
          >
            {accept.isPending ? '保存中…' : '✓ 就这么吃'}
          </button>
          <button type="button" className={styles.sec} onClick={() => setStep(1)}>
            ‹ 回去改「谁吃」
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="card" data-testid="simple-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { meat: '荤', veg: '素', soup_meat: '汤', soup_veg: '汤' };
