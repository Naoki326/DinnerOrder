import { useEffect, useState } from 'react';
import { useCandidates, type SwapCandidate, type SwapCandidates } from '../api/replacements';
import styles from './CandidateList.module.css';

/**
 * 换菜候选面板（spec S2）：3 个候选各带一句理由、外部补位菜标「没做过」、
 * 被忌口排除的同位菜带原因（「白灼虾 — 小宝忌虾」）。
 *
 * 三条硬要求，缺一不可：
 *   * **理由**：没有理由的候选就是「系统让我选它」；降级到规则排序时理由为 null，
 *     界面写「规则直接排的，没有理由」而不是编一句（与简化推荐同一纪律）。
 *   * **忌口排除原因**：看不见的排除会让人以为库里没这道菜（spec §2.3 明说要展示它）。
 *   * **「没做过」标记**：外部补位菜（spec S6）要让人知道这盘菜家里从没做过。
 *
 * **会话排除集**（spec §2.3：同一换菜会话内被换掉的 + 已出示过的候选累积排除）由**会话持有方**给：
 * 「换一整套」/「再换一个」把面板一关，组件就 unmount 了——状态留在组件里，换掉的那道菜
 * 下次就又会出现在候选里。所以本组件只负责「把自己出示过的候选并进集合 + 把集合回传」，
 * 集合本身（`sessionExcludes`）与「换掉一道菜要记进集合」由调用方维护。
 *
 * 服务端的 `exclude` 是**软排除**（池干按层放宽，见 domain/replacement.ts）——这正是 spec 要的
 * 「池干后放宽」，所以这里不做任何本地硬过滤：不出现与否由池子与放宽档位说了算。
 *
 * 两个落点共用它：定餐编辑器的已定菜单（`SlotView`）与整餐推荐面板的草稿菜单（`HomeView`）——
 * spec §2.3 说「整餐推荐**或**已定菜单下钻换掉单道」，两处是同一件事，不该有两套候选 UI。
 */
export type { SwapCandidate };

export function CandidateList({
  slotId,
  replacing,
  diners,
  dishes,
  sessionExcludes,
  onShown,
  onSwap,
  onClose,
}: {
  slotId: string;
  /** 正在被换掉的那道菜 */
  replacing: { recipeId: string; name: string };
  /** 这餐谁吃（忌口按它算）；不传 = 服务端的已定菜单快照 */
  diners?: string[];
  /** 当前菜单（草稿也要带上：推荐不落库，服务端此刻没有这一份菜单的记忆） */
  dishes: string[];
  /**
   * 本换菜会话已排除的菜（被换掉的 + 已出示过的），由会话持有方维护。
   * 打开面板时作为初值种进「已出示」名单，之后本组件继续往里并。
   */
  sessionExcludes: string[];
  /** 本批候选已出示：会话持有方把它并进会话排除集（面板一关一开，已出示的也不会重来一遍） */
  onShown: (recipeIds: string[]) => void;
  /**
   * 选中一个候选。把**整个候选**交出去而不只是 id：调用方通常要把理由与来源
   * （「没做过」）一起带进它维护的那份菜单——只给 id 会逼调用方再查一次，或者丢掉理由。
   */
  onSwap: (candidate: SwapCandidate) => void;
  onClose: () => void;
}) {
  const findCandidates = useCandidates(slotId);
  const [candidates, setCandidates] = useState<SwapCandidates | null>(null);
  // 已出示过的候选：初值 = 会话排除集，之后每次响应把自己的候选并进来（累积排除）。
  // 用 useState 的惰性初值而不是 effect 同步：effect 同步会在「换它 → 关面板」那一帧
  // 把 prop 的旧值再写回去，反而丢掉刚换掉的那道菜。
  const [shown, setShown] = useState<string[]>(() => [...new Set(sessionExcludes)]);
  const [error, setError] = useState<string | undefined>(undefined);

  /** 取一批候选并把它们记进「已出示过」的名单（会话排除靠它累积） */
  const request = (exclude: string[]): void => {
    setError(undefined);
    findCandidates.mutate(
      { replacing: replacing.recipeId, diners, dishes, exclude },
      {
        onSuccess: (result) => {
          setCandidates(result);
          const ids = result.candidates.map((item) => item.recipeId);
          setShown((current) => [...new Set([...current, ...ids])]);
          // 同步给会话持有方：面板关了再开，这一批也不会重新出现（spec §2.3 的累积排除）
          onShown(ids);
        },
        onError: (cause) => {
          setCandidates(null);
          setError(cause instanceof Error ? cause.message : '换菜候选没取回来');
        },
      },
    );
  };

  /**
   * 首次打开就取一批（面板只有在它能显示候选时才存在）。
   *
   * 用 effect 而不是「渲染期间顺手取」：取候选是一次网络请求，不能塞进渲染阶段——
   * React 可能重渲染、可能丢弃一次渲染，后果就是多打几个请求、会话排除也跟着乱。
   *
   * **首次请求就带上会话排除集**：换掉的那道菜与已出示过的候选都不该重新出现
   * （spec §2.3 的累积排除）——只拿组件自己的 `shown`（初值空）发首次请求的话，
   * 刚换掉的那道菜会在换下一个位置时重新进候选。
   *
   * 依赖只写 `replacing.recipeId`（而不是整个 request 函数）：这份候选是「换这一道菜」的
   * 候选，换的目标变了才需要重新取；`diners`/`dishes` 是随每次请求现读的 props，
   * 在编辑期间变了也不该自动重发（那会让「再换一个」的半路状态被打断）。
   */
  useEffect(() => {
    request([...new Set(sessionExcludes)]);
  }, [replacing.recipeId]);

  // 池子放宽到会话档：已出示过的候选都被重新拿出来了，「再换一个」不再是「换一批新的」。
  // 文案从 `relaxed` 现场推，而不是拿服务端的 `notes`（那是诊断痕迹，界面文案是展示层的事）。
  const recycled = candidates?.relaxed === 'session';
  const simplified = candidates?.llm.format === 'rules_only';
  const relaxedNote =
    candidates?.relaxed === 'dedupe'
      ? '同位候选不多了：这几道里有近 7 天刚做过的。'
      : candidates?.relaxed === 'session'
        ? '同位候选快用完了：这几道刚才已经出示过。'
        : undefined;

  return (
    <div className={styles.panel} data-testid="candidate-panel">
      <div className={styles.head}>
        <span>
          换掉 {replacing.name}
          {candidates ? ` · 候选（${candidates.candidates.length} 个）· 忌口已排除` : ' · 正在找候选…'}
        </span>
        <button type="button" className={styles.close} data-testid="close-candidates" onClick={onClose}>
          ✕
        </button>
      </div>

      {simplified ? (
        <div className={styles.note} data-testid="candidates-degraded">
          LLM 这次没接上，这几个是规则排序给的（时令 + 没做过 + 爱吃 + 快手），没有理由。
        </div>
      ) : null}
      {relaxedNote ? (
        <div className={styles.note} data-testid="candidates-relaxed">
          {relaxedNote}
        </div>
      ) : null}
      {error ? (
        <div className={styles.note} data-testid="candidates-error">
          {error}
        </div>
      ) : null}

      {candidates?.candidates.map((candidate) => (
        <div key={candidate.recipeId} className={styles.row} data-testid={`candidate-${candidate.recipeId}`}>
          <div className={styles.body}>
            <span className={styles.name}>
              {candidate.name}
              {candidate.origin === 'external' ? (
                <span className="badge" data-testid={`candidate-external-${candidate.recipeId}`}>
                  没做过
                </span>
              ) : null}
            </span>
            <span className={styles.reason} data-testid={`candidate-reason-${candidate.recipeId}`}>
              {candidate.reason ?? '规则直接排的，没有理由'}
            </span>
          </div>
          <button
            type="button"
            className="btn"
            data-testid={`use-candidate-${candidate.recipeId}`}
            onClick={() => onSwap(candidate)}
          >
            换它
          </button>
        </div>
      ))}

      {/* 被忌口排除的同位菜：这就是 spec 要的「白灼虾 — 小宝忌虾」那一行 */}
      {candidates?.excluded.map((entry) => (
        <div key={entry.recipeId} className={styles.excluded} data-testid={`candidate-excluded-${entry.recipeId}`}>
          <span className={styles.strike}>{entry.name}</span>
          <span className={styles.reason}> — {entry.reason}</span>
        </div>
      ))}

      {candidates || error ? (
        <button
          type="button"
          className="btn ghost block"
          data-testid="another-candidate"
          disabled={findCandidates.isPending}
          onClick={() => request(shown)}
        >
          {findCandidates.isPending ? '…' : recycled ? '🔄 重新看一遍' : '🔄 再换一个'}
        </button>
      ) : null}
    </div>
  );
}
