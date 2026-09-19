import { useState } from 'react';
import { Link } from 'react-router';
import { useIdentity } from '../identity';
import { useSlots, type SlotWithPortion } from '../api/meals';
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
 * 才不会出现「C 里不能改用餐者」这种语义缺口。留量（🌙）与回顾是后续工单的事，这里不放空按钮。
 */
export function SimpleView() {
  const slotsQuery = useSlots(3);
  const [wizard, setWizard] = useState(false);

  const slots = slotsQuery.data?.slots ?? [];
  const today = slotsQuery.data?.today;
  // 一屏一事：只关心最近那一件**还没定**的事（已定的餐不在这里出现——想看就去 B 的日程）
  const next = slots.find((slot) => slot.status === 'undecided');

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

  return (
    <div className={styles.wrap} data-testid="simple-view">
      {next ? (
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
    </div>
  );
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
