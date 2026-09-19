import { useState } from 'react';
import { useDeleteFeedback, useSaveFeedback, type DishFeedback, type FeedbackTag } from '../api/feedback';
import styles from './FeedbackBar.module.css';

/**
 * 反馈条（总纲 §2.5、CONTEXT「餐后回顾」）：点赞/点踩 + 快捷标签。
 *
 * **一个组件两处落点**，因为 spec 明说这是**同套**反馈：
 *   * 菜单阶段——菜单卡/编辑器里的单道菜，顺手点个踩 + 标签（点踩当场生效冷藏期）；
 *   * 餐后回顾——饭后餐卡的常驻「吃后感」入口，点赞/点踩 + 同一套标签。
 * 两处的线上形状与语义完全一致（同一张表、同一个 `POST /api/feedback`），差别只有落点与文案，
 * 所以不该有两套 UI——那正是会漂移的地方。
 *
 * 反馈归属**当前身份**（总纲 §2.4 无登录）：`memberId` 由调用方从 `useIdentity()` 取当前家人，
 * 服务端不猜「是谁在说话」——「谁觉得太油」是这条记录的全部价值。
 *
 * 三条交互上的判断：
 *   * 点赞/点踩是**布尔**，再点**另一颗**是**改主意**（服务端 UPDATE 同一行，不堆历史）；
 *     再点同一颗不去回退（免得误触把话弄丢）——回退是旁边那个明确的「撤回」；
 *   * 快捷标签在**点踩**时总会出现；餐后回顾那一路（`tagsOnLike`）**点赞也能贴**——总纲 §2.5
 *     的两句话：「菜单阶段：单道菜点踩 + 可选快捷标签」与「餐后回顾：点踩/点赞 + 同套快捷标签」。
 *     标签进摘要回答「为什么」（太油/太甜/量太多），判定进冷藏期回答「还推不推」（ADR-0005）：
 *     两条路各管一件事，所以标签在回顾里不该被判定锁住。再点一下取消该标签；
 *   * 「撤回」是第三种状态（什么都不说）：判定只有赞/踩两种，撤回用删除表达。
 */
export function FeedbackBar({
  slotId,
  recipeId,
  recipeName,
  memberId,
  memberName,
  current,
  testIdPrefix,
  compact = false,
  tagsOnLike = false,
}: {
  slotId: string;
  recipeId: string;
  /** 菜名（确认文案与 aria-label 用；错点撤回时界面能说清撤的是哪一道） */
  recipeName: string;
  /** 当前身份（无登录：反馈归属说话的人） */
  memberId: string | undefined;
  memberName: string | undefined;
  /** 当前身份对这一餐这道菜已有的反馈（undefined = 还没说过） */
  current: DishFeedback | undefined;
  /** 同一页有多处反馈条（菜单卡 / 回顾卡），testid 要能区分 */
  testIdPrefix: string;
  /** 紧凑排列（菜单卡里一行放不下时用） */
  compact?: boolean;
  /** 点赞时也摆出快捷标签（**餐后回顾**那一路；总纲 §2.5 的两句原文不同，机制也不同） */
  tagsOnLike?: boolean;
}) {
  const save = useSaveFeedback();
  const remove = useDeleteFeedback();
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingTags, setPendingTags] = useState<FeedbackTag[] | null>(null);

  // 标签集合的真相：服务端回来的那条（乐观值只在提交中顶一下，避免点一下闪一下）
  const tags = pendingTags ?? current?.tags ?? [];
  const verdict = current?.verdict;

  const submit = (nextVerdict: 'like' | 'dislike', nextTags: FeedbackTag[]): void => {
    if (!memberId) return;
    setError(undefined);
    save.mutate(
      { slotId, recipeId, memberId, verdict: nextVerdict, tags: nextTags },
      {
        onSuccess: () => setPendingTags(null),
        onError: (cause) => {
          setPendingTags(null);
          setError(cause instanceof Error ? cause.message : '反馈没存上');
        },
      },
    );
  };

  /** 点一下判定：换成另一判定 = 改主意；同一判定再点 = 不做（回退走「撤回」） */
  const chooseVerdict = (next: 'like' | 'dislike'): void => {
    if (!memberId || verdict === next) return;
    // 菜单阶段（总纲 §2.5：点踩 + 标签）切到点赞时旧标签清掉：那里的标签只说「哪里不对」。
    // 餐后回顾（`tagsOnLike`）里点赞也能贴标签，标签因此与判定解耦，切判定不动标签。
    submit(next, next === 'dislike' || tagsOnLike ? tags : []);
  };

  /** 再点一下取消该标签（整体替换那一行反馈的标签集）；判定保持当前这一颗 */
  const toggleTag = (tag: FeedbackTag): void => {
    const next = tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag];
    setPendingTags(next);
    submit(verdict ?? 'dislike', next);
  };

  const busy = save.isPending || remove.isPending;

  return (
    <div className={compact ? `${styles.bar} ${styles.compact}` : styles.bar} data-testid={`${testIdPrefix}-feedback-${recipeId}`}>
      <div className={styles.actions}>
        <button
          type="button"
          className={verdict === 'like' ? `${styles.vote} ${styles.onLike}` : styles.vote}
          data-testid={`${testIdPrefix}-like-${recipeId}`}
          aria-pressed={verdict === 'like'}
          aria-label={`给${recipeName}点赞`}
          disabled={!memberId || busy}
          onClick={() => chooseVerdict('like')}
        >
          👍
        </button>
        <button
          type="button"
          className={verdict === 'dislike' ? `${styles.vote} ${styles.onDislike}` : styles.vote}
          data-testid={`${testIdPrefix}-dislike-${recipeId}`}
          aria-pressed={verdict === 'dislike'}
          aria-label={`给${recipeName}点踩`}
          disabled={!memberId || busy}
          onClick={() => chooseVerdict('dislike')}
        >
          👎
        </button>
        {verdict === 'like' ? (
          <span className={styles.hint} data-testid={`${testIdPrefix}-liked-${recipeId}`}>
            {memberName ?? '有人'}觉得不错
          </span>
        ) : null}
        {verdict !== undefined ? (
          <button
            type="button"
            className={styles.clear}
            data-testid={`${testIdPrefix}-clear-${recipeId}`}
            disabled={busy}
            onClick={() =>
              memberId &&
              remove.mutate(
                { slotId, recipeId, memberId },
                { onError: (cause) => setError(cause instanceof Error ? cause.message : '撤回没成功') },
              )
            }
          >
            撤回
          </button>
        ) : null}
      </div>

      {verdict !== undefined && (verdict === 'dislike' || tagsOnLike) ? (
        <div className={styles.tags} data-testid={`${testIdPrefix}-tags-${recipeId}`}>
          <span className={styles.tagLabel}>{verdict === 'like' ? '还想说一句：' : '哪里不对：'}</span>
          {FEEDBACK_TAG_OPTIONS.map((tag) => {
            const on = tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={on ? `${styles.tag} ${styles.tagOn}` : styles.tag}
                data-testid={`${testIdPrefix}-tag-${tag}-${recipeId}`}
                aria-pressed={on}
                disabled={busy}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <div className={styles.error} data-testid={`${testIdPrefix}-feedback-error-${recipeId}`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 快捷标签的选项表（总纲 §2.5 的「3–4 个」）。
 *
 * 与 `wire-types.ts` 的 `FeedbackTag` 同源（类型侧），这里只决定**排列顺序**：
 * 先「太油/太甜」这两句最常说的，再「量太多/量太少」。服务端回显也按这个顺序（domain/feedback.ts）。
 */
const FEEDBACK_TAG_OPTIONS: FeedbackTag[] = ['太油', '太甜', '量太多', '量太少'];
