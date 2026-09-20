import { Fragment, useEffect, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { apiBaseUrl } from '../config';
import { useHealth } from '../api/health';
import { useIdentity } from '../identity';
import { useSlots, useBookLeftover, useCancelSlot, type MealSlot, type SlotWithPortion } from '../api/meals';
import {
  useAcceptRecommendation,
  useRecommendation,
  type MealRecommendation,
} from '../api/recommendations';
import { feedbackOf, useFeedback, type CoolingDish, type DishFeedback } from '../api/feedback';
import { CandidateList, type SwapCandidate } from '../components/CandidateList';
import { FeedbackBar } from '../components/FeedbackBar';
import { NutritionSheet } from '../components/NutritionSheet';
import { RecipeSheet } from '../components/RecipeSheet';
import styles from './HomeView.module.css';

/**
 * A 视图（默认）：下一餐大卡。
 *
 * 这一票把它接上真实的餐槽数据：最近未定的一餐就是主卡（点进定餐编辑器），
 * 往下按天列出后面的餐槽卡。服务端已经把「已经过了的餐次」滤掉了（午 14:00 / 晚 21:00
 * 截止，家庭时区），首页不需要自己再判一次时间。
 *
 * 「给我推荐」是**显式触发**的（总纲 §2.2）：点一下才向后端要一份整餐推荐，
 * 拿到后在本卡位置展开推荐面板——每道菜带一句理由、「没做过」标记与一键接受。
 * 摘下的菜照旧进编辑器（定餐 = 换菜，同一个编辑器），只是推荐把草稿预填好了。
 *
 * 已定的卡直接显示**每道菜的本餐生重**（`slot.portion` 由列表接口内嵌，份量已随时钟现算）；
 * 逐食材的拆解在定餐编辑器里（大卡只给每道菜的合计——手机首屏容不下逐食材列表）。
 */
export function HomeView() {
  const health = useHealth();
  const slots = useSlots(3);
  // 从编辑器取消被「吃剩的」引用的那一餐时，服务端把引用方一起退回了未定（#22）。
  // 那句话要在这边说得出来：取消之后这一页就是家的全部视野，不提示等于让晚餐默认“消失”。
  const released = useReleaseNotice();
  const feedback = useFeedback();

  const list = slots.data?.slots ?? [];
  const today = slots.data?.today;
  const next = list.find((slot) => slot.status === 'undecided') ?? list[0];
  const rest = list.filter((slot) => slot.id !== next?.id);

  return (
    <div data-testid="home-view">
      {released.length > 0 ? (
        <div className="card" data-testid="release-notice">
          <span className="sub">
            {/* 服务端下发的 `released` 是**原始槽 id**（'2025-06-02:dinner'）：数据库主键不该念给用户听，
                这里渲染成「今天晚餐」这种人话（与餐槽卡的 dayLabel 同一口径） */}
            取消成功：{released.map((id) => slotLabel(id, today)).join('、')} 吃的是这一餐剩的，已经一起退回未定了。
          </span>
        </div>
      ) : null}
      {slots.isPending ? (
        <div className={`card ${styles.hero}`} data-testid="slots-loading">
          <div className={styles.kicker}>最近未定餐槽</div>
          <div className={styles.headline}>读取中…</div>
        </div>
      ) : slots.isError ? (
        <div className={`card ${styles.hero}`} data-testid="slots-error">
          <div className={styles.kicker}>最近未定餐槽</div>
          <div className={styles.headline}>餐槽没读回来</div>
          <div className="sub">检查一下网络或服务是不是停了。</div>
        </div>
      ) : next ? (
        <HeroCard slot={next} today={today} feedback={feedback.data?.feedback} cooling={feedback.data?.cooling ?? []} />
      ) : (
        <div className={`card ${styles.hero}`} data-testid="empty-slot">
          <div className={styles.kicker}>最近未定餐槽</div>
          <div className={styles.headline}>这几天都排满了</div>
          <div className="sub">没定的餐 app 不打扰——可能在外吃、吃剩的。</div>
        </div>
      )}

      {rest.map((slot) => (
        <GhostCard key={slot.id} slot={slot} today={today} />
      ))}

      <div className={styles.footnote}>没定的餐 app 不打扰 —— 可能在外吃、吃剩的。</div>

      <footer className={`card sub`} data-testid="health-footer">
        <div className="spread">
          <span>API：{apiBaseUrl}</span>
          {health.isPending ? (
            <span className="badge">检查中…</span>
          ) : health.isError ? (
            <span className="badge warn">连接异常</span>
          ) : (
            <span className="badge ok" data-testid="health-ok">
              服务正常
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * 取消联动带回来的提示（#22）：`SlotView` 把 `DELETE` 响应里的 `released` 经路由 state 递过来。
 *
 * 落页时把内容**拷贝进组件状态**再清掉历史里的 state：直接读 `location.state` 会在清理后
 * 变成空（提示一闪而过），而留在历史里又会在刷新时冤枉复活。
 */
function useReleaseNotice(): string[] {
  const location = useLocation();
  const navigate = useNavigate();
  const [released] = useState<string[]>(
    () => (location.state as { released?: string[] } | null)?.released ?? [],
  );
  useEffect(() => {
    if (released.length > 0) navigate('.', { replace: true, state: null });
  }, [released.length, navigate]);
  return released;
}

/** 最近的一餐：定餐的入口（未定）或查看/改餐的入口（已定） */
function HeroCard({
  slot,
  today,
  feedback,
  cooling,
}: {
  slot: SlotWithPortion;
  today: string | undefined;
  /** 近 30 天的反馈（菜单阶段的点踩从它读回当前身份说过什么） */
  feedback: DishFeedback[] | undefined;
  /** 正在冷藏期的菜（说清「这道为什么没进推荐」） */
  cooling: CoolingDish[];
}) {
  const { current } = useIdentity();
  const decided = slot.status === 'decided';
  const leftover = slot.menu?.leftoverSlotId ?? null;
  const leftOverSource = slot.leftoverSource;
  const bookLeftover = useBookLeftover();
  const cancel = useCancelSlot();
  // 未定的餐槽没有名单快照，默认全员（与编辑器同一口径）；已定的用当时的快照
  const { members } = useIdentity();
  const [recommendation, setRecommendation] = useState<MealRecommendation | null>(null);
  // 「换一整套」前那一份**草稿**推荐：草稿没落库（总纲 §4），所以「上一套」只能在前端留住。
  // 这与已定餐槽的 `undo-set` 是两条路：那边的上一套是服务端从 append-only 留痕推导的
  // （domain/slots.ts 的 undoSet），这边的草稿里没有留痕可推。
  const [previousRecommendation, setPreviousRecommendation] = useState<MealRecommendation | null>(null);
  // 换菜会话序号：整份草稿被换掉（换一整套 / 撤销）就是新会话，会话内的累积排除要跟着清空。
  // 用 `key` 重挂载面板而不是从外面递 sessionExcludes 进去：面板本来就是一个会话的自然载体。
  const [sessionSeq, setSessionSeq] = useState(0);
  const recommend = useRecommendation(slot.id);
  const accept = useAcceptRecommendation(slot.id);
  const [error, setError] = useState<string | undefined>(undefined);
  // 两个弹层（本票）：整餐营养 / 单道菜食谱。与编辑器同一对面板，只是这边的菜行没有逐食材份量
  const [nutritionOpen, setNutritionOpen] = useState(false);
  const [recipeOf, setRecipeOf] = useState<{ recipeId: string; name: string } | null>(null);

  const request = (): void => {
    setError(undefined);
    recommend.mutate(
      {},
      {
        onSuccess: (result) => {
          // 有旧草稿才记「上一份」：首次推荐没有可撤销的东西（撤销按钮只在真有上一份时出现）
          setPreviousRecommendation(recommendation);
          setRecommendation(result);
          setSessionSeq((current) => current + 1);
        },
        onError: (cause) => setError(cause instanceof Error ? cause.message : '推荐失败'),
      },
    );
  };

  /**
   * 撤销「换一整套」：回到换之前那一份草稿（spec §2.3 的「可反悔」）。
   * 只走一步：恢复之后没有更早的草稿可退（与已定餐槽的 `canUndoSet` 同一口径，不做 ping-pong）。
   */
  const undoRecommendation = (): void => {
    if (!previousRecommendation) return;
    setRecommendation(previousRecommendation);
    setPreviousRecommendation(null);
    setSessionSeq((current) => current + 1);
  };

  const acceptRecommendation = (): void => {
    if (!recommendation) return;
    setError(undefined);
    accept.mutate(
      {
        booking: {
          diners: recommendation.diners.map((diner) => diner.memberId),
          dishes: recommendation.dishes.map((dish) => dish.recipeId),
          // 掌勺者（本票）：已定餐槽保留当时那位；未定的不传（服务端按家里的习惯缺省）
          ...(slot.cook ? { cook: slot.cook.memberId } : {}),
        },
        recommendation,
      },
      {
        // 接受成功后收起面板：菜单已经落库，卡片上会直接显示它（面板再挂在那儿是重复的）；
        // 草稿被接受，上一份也就没有可撤销的意义了
        onSuccess: () => {
          setRecommendation(null);
          setPreviousRecommendation(null);
        },
        onError: (cause) => setError(cause instanceof Error ? cause.message : '保存失败'),
      },
    );
  };

  const doBookLeftover = (): void => {
    if (!leftOverSource) return;
    setError(undefined);
    bookLeftover.mutate(
      {
        slotId: slot.id,
        leftoverOf: leftOverSource.slotId,
        diners: slot.menu?.diners.map((diner) => diner.memberId) ?? members.map((member) => member.id),
        // 掌勺者（本票）：未定的餐槽不传（服务端按家里的习惯缺省）
        ...(slot.cook ? { cook: slot.cook.memberId } : {}),
      },
      { onError: (cause) => setError(cause instanceof Error ? cause.message : '预定「吃剩的」失败') },
    );
  };

  return (
    <div className={`card ${styles.hero}`} data-testid="empty-slot" data-slot-id={slot.id}>
      <div className={styles.kicker}>{decided ? '最近这一餐' : '最近未定餐槽'}</div>
      <div className={styles.headline}>
        {dayLabel(slot, today)} · {slot.meal === 'lunch' ? '午餐' : '晚餐'}
        {decided ? <span className="badge ok"> 已定</span> : null}
      </div>

      {decided && leftover ? (
        // 「吃剩的」那一餐：菜单是从被引用那一餐**现推导**的（总纲 §2.6），
        // 界面要把这一层说出来，否则家人看不出“为什么这顿没有新采购”
        <div className={styles.leftoverNote} data-testid="hero-leftover">
          🌙 吃 {leftoverSourceLabel(leftover, today)} 剩的 —— 不另采购，做菜量已按留量上浮
        </div>
      ) : null}

      {/* 掌勺者（本票）：餐槽卡上看得见「这一餐谁做」。\n          已定用当时的快照；未定用服务端下发的 `cookDefault`（按上一餐继承，缺省口径只服务端一处），\n          并说清是「照上一餐」——真正的权威判定在服务端。已定但没指定就**不编**一个回头缺省\n          （那一餐就是没指定；写上一个名字会让人以为菜单上真记了他）。 */}
      <div className={styles.cookLine} data-testid="hero-cook">
        {slot.cook ? (
          <>👨‍🍳 掌勺者：{slot.cook.emoji} {slot.cook.name}</>
        ) : decided ? (
          <span className="sub">掌勺者：未指定</span>
        ) : slot.cookDefault ? (
          <>👨‍🍳 掌勺者：{slot.cookDefault.emoji} {slot.cookDefault.name}（照上一餐）</>
        ) : (
          <span className="sub">掌勺者：未指定（定的时候可以指定）</span>
        )}
      </div>

      {decided && slot.menu ? (
        <div className={styles.dishList} data-testid="hero-dishes">
          {slot.menu.dishes.map((dish) => {
            // 份量按菜品 index 对齐：列表接口内嵌的 portion.dishes 与 menu.dishes 同序同长
            // （都由 resolveDishes 按提交顺序产出），所以这里用下标取本餐生重
            const grams = slot.portion?.dishes.find((item) => item.recipeId === dish.recipeId)?.totalGrams;
            // 留量倍数从**服务端算好的** `portion.uplift` 读（#22 台账第二条：不再硬编码 ×1.5）。
            // `uplift` 是「实际生效」的那个：留量标记 ∧ 有效引用两道门都过了才是 1.5，
            // 否则是 1——所以这里只在真上浮时才标倍数，不标一个没兑现的数。
            const dishUplift = slot.portion?.dishes.find((item) => item.recipeId === dish.recipeId)?.uplift ?? 1;
            return (
              <div key={dish.recipeId} className={styles.dishRow} data-testid={`hero-dish-${dish.recipeId}`}>
                <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
                <span>{dish.name}</span>
                {dish.keepLeftover ? (
                  <span className="badge" data-testid={`hero-dish-keep-${dish.recipeId}`}>
                    留量{dishUplift !== 1 ? ` ×${dishUplift}` : ''}
                  </span>
                ) : null}
                {/* 食谱（本票）：每道菜行上的入口（用户口径）。大卡上没有逐食材份量读数，
                    所以面板只给成人份基准（食谱本身的口径）——编辑器里那份会多一列「本餐」。 */}
                <button
                  type="button"
                  className={styles.dishRecipe}
                  data-testid={`hero-dish-recipe-${dish.recipeId}`}
                  aria-haspopup="dialog"
                  aria-expanded={recipeOf?.recipeId === dish.recipeId}
                  aria-label={`${dish.name} 的食谱`}
                  onClick={() => setRecipeOf({ recipeId: dish.recipeId, name: dish.name })}
                >
                  食谱
                </button>
                {grams !== undefined ? (
                  <span className={styles.grams} data-testid={`hero-dish-grams-${dish.recipeId}`}>
                    {grams} g
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* 冷藏期的菜要说清为什么它暂时不在推荐里（「看不见的排除」与换菜候选的忌口排除同一纪律）。
          ⚠️ 文案说的是 `until` 的**真实语义**：它是解除那天（feedback.ts：最后一次点踩 + 冷藏期天数），
          所以是「起**可以再推**」——不能只说「`until` 起」，那会被读成「从这天开始不推」（语义反了）。 */}
      {decided && slot.menu && cooledInMenu(slot, cooling).length > 0 ? (
        <div className={styles.coolingNote} data-testid="hero-cooling">
          有人点过踩，这道菜暂时不推：{cooledInMenu(slot, cooling).map((dish) => `${dish.name}（${dish.until} 起可以再推）`).join('、')}
        </div>
      ) : null}

      {/* 菜单阶段的反馈（总纲 §2.5）：单道点踩 + 快捷标签。点了踩当场进冷藏期——
          所以它不只记一笔，而是真的改变下一次推荐（这一点在文案里说清）。 */}
      {decided && slot.menu && current ? (
        <div className={styles.feedbackBlock} data-testid="hero-feedback">
          <div className={styles.feedbackLabel}>这餐的吃后感（归属 {current.emoji} {current.name}）</div>
          {slot.menu.dishes.map((dish) => (
            <div key={dish.recipeId} className={styles.feedbackRow}>
              <span className={styles.feedbackName}>{dish.name}</span>
              <FeedbackBar
                slotId={slot.id}
                recipeId={dish.recipeId}
                recipeName={dish.name}
                memberId={current.id}
                memberName={current.name}
                current={feedbackOf(feedback, slot.id, dish.recipeId, current.id)}
                testIdPrefix="hero"
                compact
              />
            </div>
          ))}
        </div>
      ) : null}

      {recommendation ? (
        <RecommendationPanel
          key={sessionSeq}
          slotId={slot.id}
          recommendation={recommendation}
          canUndo={previousRecommendation !== null}
          pending={accept.isPending}
          onAccept={acceptRecommendation}
          onUndo={undoRecommendation}
          onDiscard={() => {
            setRecommendation(null);
            setPreviousRecommendation(null);
          }}
          onSwap={(recipeId, candidate) =>
            setRecommendation((current) =>
              current
                ? {
                    ...current,
                    // 换掉的不只是 id：菜名、荤素位、来源与理由都换成新候选的——
                    // 留着上一道菜的理由去描述这一道，界面与留痕里都是假证据
                    dishes: current.dishes.map((dish) =>
                      dish.recipeId === recipeId
                        ? {
                            recipeId: candidate.recipeId,
                            name: candidate.name,
                            kind: candidate.kind,
                            origin: candidate.origin,
                            reason: candidate.reason,
                          }
                        : dish,
                    ),
                  }
                : current,
            )
          }
        />
      ) : null}

      {error ? (
        <div className={styles.recommendError} data-testid="recommend-error">
          {error}
        </div>
      ) : null}

      {/* 整餐营养（本票）：按钮在餐槽卡上（用户口径）。已定的那一餐才有菜单/份量；
          没定时按钮不出来（没有菜单就没有营养）。 */}
      {decided && slot.menu ? (
        <button
          type="button"
          className="btn ghost block"
          data-testid="hero-nutrition-button"
          aria-haspopup="dialog"
          aria-expanded={nutritionOpen}
          style={{ marginTop: 8 }}
          onClick={() => setNutritionOpen(true)}
        >
          📊 营养（能量 · 蛋白 · 脂肪 · 碳水）
        </button>
      ) : null}

      <Link className="btn block" to={`/slot/${slot.id}`} data-testid={decided ? 'edit-slot-button' : 'book-slot-button'}>
        {decided ? '✏️ 看看 / 改这餐' : '🍽 现在定这一餐'}
      </Link>

      <div className={styles.actions}>
        {/* 显式触发（总纲 §2.2）：打开餐槽不自动生成，点一下才问 LLM。
            推荐过之后按钮变「换一整套」的措辞——再点就是重新现算一份（不缓存）。 */}
        <button
          type="button"
          className="btn ghost"
          data-testid="recommend-button"
          disabled={recommend.isPending || !slot.editable}
          onClick={request}
        >
          {recommend.isPending ? '正在配餐…' : recommendation ? '🔄 换一整套' : '✨ 给我推荐'}
        </button>
        {/* 「吃剩的」（#22）：只在晚餐、且同日午餐已定下留量菜时才给入口——这个判定
            由服务端下发（`leftoverSource`），前端不自己猜（它连今天午餐定没定都不一定看得见）。
            已定餐槽不再重复给入口（要改就去编辑器里取消）。 */}
        {leftOverSource && !decided ? (
          <button
            type="button"
            className="btn ghost"
            data-testid="book-leftover-button"
            disabled={bookLeftover.isPending || !slot.editable}
            onClick={doBookLeftover}
          >
            {bookLeftover.isPending ? '预定中…' : '🌙 吃中午剩的'}
          </button>
        ) : null}
        {decided && leftover ? (
          <button
            type="button"
            className="btn ghost"
            data-testid="cancel-leftover-button"
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(slot.id, {
                onError: (cause) => setError(cause instanceof Error ? cause.message : '取消失败'),
              })
            }
          >
            {cancel.isPending ? '取消中…' : '不吃剩的了'}
          </button>
        ) : null}
      </div>
      <div className="sub" style={{ marginTop: 10 }}>
        手动挑菜按同一条编辑路径走；「给我推荐」按这餐的人、忌口与时令现配一份。
      </div>

      {nutritionOpen ? <NutritionSheet slotId={slot.id} onClose={() => setNutritionOpen(false)} /> : null}
      {recipeOf ? (
        <RecipeSheet
          recipeId={recipeOf.recipeId}
          recipeName={recipeOf.name}
          onClose={() => setRecipeOf(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 推荐面板：结构摘要 + 每道菜的理由 + 「没做过」+ 一键接受。
 *
 * 两处「显著标记」是 spec 的硬要求，不是装饰：
 *   * 外部补位菜标「没做过」（spec S6）——家人要知道这盘菜家里没做过；
 *   * 简化推荐标警示条（spec S7）——LLM 没参与时必须说清，否则家人会以为那是模型配的。
 *
 * 还带一个「换」入口（spec §2.3：**整餐推荐或已定菜单**下钻换单道）：候选走同一条
 * `/candidates` 接口与同一个候选面板，只是整份推荐还没落库——所以把草稿菜单原样传过去
 * （服务端此刻手里没有它）。换掉的只是本地草稿，接受时提交的是换过之后的那一份。
 *
 * **换菜会话**：面板打开着就是同一个会话（同样的 `key` 重挂载 = 新草稿 = 新会话），
 * 排除集（被换掉的 + 已出示过的候选）留在面板这一层（spec §2.3 的累积排除）。
 *
 * **「上一套」**（spec §2.3「可反悔」）：这块草稿没落库，所以只能在内存里留住上一份，
 * 由 `canUndo`/`onUndo` 交给持有两份草稿的 `HeroCard`——与已定餐槽的 `undo-set`（服务端
 * 从 append-only 留痕推导）是两条实现路，但用户看到的语义都是「退回上一套」。
 */
function RecommendationPanel({
  slotId,
  recommendation,
  canUndo,
  pending,
  onAccept,
  onUndo,
  onDiscard,
  onSwap,
}: {
  slotId: string;
  recommendation: MealRecommendation;
  /** 存在上一份草稿时才给撤销入口（首次推荐没有可撤销的东西） */
  canUndo: boolean;
  pending: boolean;
  onAccept: () => void;
  onUndo: () => void;
  onDiscard: () => void;
  onSwap: (recipeId: string, candidate: SwapCandidate) => void;
}) {
  const simplified = recommendation.llm.format === 'rules_only';
  const structure = recommendation.structure;
  const [swapping, setSwapping] = useState<{ recipeId: string; name: string } | null>(null);
  const [sessionExcludes, setSessionExcludes] = useState<string[]>([]);

  return (
    <div className={styles.recommendPanel} data-testid="recommendation-panel">
      <div className={styles.recommendHead}>
        <span data-testid="recommendation-structure">
          按家规配：{structure.meat} 荤 · {structure.veg} 素 · {structure.soup} 汤
        </span>
        {simplified ? (
          <span className="badge warn" data-testid="recommendation-degraded">
            简化推荐
          </span>
        ) : null}
      </div>

      {simplified ? (
        <div className={styles.recommendNote} data-testid="recommendation-note">
          LLM 这次没接上，这份是规则直接拼的（时令 + 荤素结构 + 去重 + 爱吃）。
          {recommendation.notes.length > 0 ? `（${recommendation.notes[recommendation.notes.length - 1]}）` : ''}
        </div>
      ) : null}

      <div className={styles.dishList} data-testid="recommendation-dishes">
        {recommendation.dishes.map((dish) => (
          <div key={dish.recipeId} data-testid={`recommend-dish-${dish.recipeId}`}>
            <div className={styles.recommendDish}>
              <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
              <span className={styles.recommendName}>
                {dish.name}
                {dish.origin === 'external' ? (
                  <span className="badge" data-testid={`recommend-external-${dish.recipeId}`}>
                    没做过
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className={styles.recommendSwap}
                data-testid={`recommend-swap-${dish.recipeId}`}
                onClick={() => setSwapping(swapping?.recipeId === dish.recipeId ? null : dish)}
              >
                换
              </button>
              <span className={styles.recommendReason}>{dish.reason ?? '规则直接拼的，没有理由'}</span>
            </div>
            {swapping?.recipeId === dish.recipeId ? (
              <CandidateList
                slotId={slotId}
                replacing={{ recipeId: dish.recipeId, name: dish.name }}
                diners={recommendation.diners.map((diner) => diner.memberId)}
                dishes={recommendation.dishes.map((item) => item.recipeId)}
                sessionExcludes={sessionExcludes}
                onShown={(ids) => setSessionExcludes((current) => [...new Set([...current, ...ids])])}
                onSwap={(candidate) => {
                  // 被换掉的那道进会话排除集（spec §2.3）：草稿菜单变了也仍然记得它被换过
                  setSessionExcludes((current) => [...new Set([...current, dish.recipeId])]);
                  onSwap(dish.recipeId, candidate);
                  setSwapping(null);
                }}
                onClose={() => setSwapping(null)}
              />
            ) : null}
          </div>
        ))}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className="btn block"
          data-testid="accept-recommendation"
          disabled={pending}
          onClick={onAccept}
        >
          {pending ? '保存中…' : '✅ 就这一套，定下来'}
        </button>
        {/* 撤销只在真有上一份草稿时出现：常亮的按钮会让人以为有东西可撤 */}
        {canUndo ? (
          <button type="button" className="btn ghost" data-testid="undo-recommendation" onClick={onUndo}>
            ↩ 撤销，回到上一套
          </button>
        ) : null}
        <button type="button" className="btn ghost" data-testid="discard-recommendation" onClick={onDiscard}>
          先不要
        </button>
      </div>
      <div className="sub" style={{ marginTop: 8 }}>
        定下来之后还可以像手动档一样换菜、改用餐者。
      </div>
    </div>
  );
}

/**
 * 「同一日的午餐」这种说法直接写给人看：'2025-06-02:lunch' → 「今天中午」/「6/2 中午」。
 * 引用永远指同日午餐（总纲 §2.6），所以不必渲染出餐次——日期部分与 `slotLabel` 共用 `dateLabel`。
 */
function leftoverSourceLabel(slotId: string, today?: string): string {
  return `${dateLabel(slotId.slice(0, 10), today)} 中午`;
}

/**
 * 槽 id → 人话，**同时说清日期与餐次**：'2025-06-02:dinner' → 「今天晚餐」/「6/2 晚餐」。
 *
 * 与 `leftoverSourceLabel` 不能合并成同一个函数：那个专说「同一日的午餐」（引用形态的语义是
 * 晚餐吃中午剩的，餐次恒为「中午」，写进文案才读得通）；这里要覆盖午/晚两种餐次（取消联动
 * 下发的 `released` 是晚餐，但助手本身不该假设）。两者共用日期部分（`dateLabel`），避免两份同形逻辑。
 */
export function slotLabel(slotId: string, today: string | undefined): string {
  const meal = slotId.endsWith(':lunch') ? '午餐' : '晚餐';
  return `${dateLabel(slotId.slice(0, 10), today)}${meal}`;
}

/**
 * 往下的餐槽：未定/已定都列出来，点了就进编辑器。
 *
 * 已定的这一张也带**营养与食谱**入口（本票修的可达性缺口）：大卡只显示「最近未定餐槽」，
 * 已定的餐会落到这里——若这一层没有入口，「每餐的营养 / 每道菜的食谱」就只有恰好轮到大卡
 * 的那一餐能用上。菜名本身就是食谱入口（逐道菜，不是只给一道），营养是卡片底部的一枚小按钮。
 *
 * ⚠️ 整张卡是 `<Link>`（`<a>`）：里面的按钮必须自己挡住链接的默认行为，否则点按钮会顺带
 * 跳进定餐编辑器。`preventDefault()` 让 react-router 的 Link 看到 `defaultPrevented` 而不再
 * 导航，`stopPropagation()` 再挡一层合成事件冒泡——两个都要，缺一个在改版后都可能漏。
 */
function GhostCard({ slot, today }: { slot: SlotWithPortion; today: string | undefined }) {
  const decided = slot.status === 'decided';
  const dishes = slot.menu?.dishes ?? [];
  // 预告只列前三道（卡片是买菜前的扫一眼）；超过就报总数，逐道的完整清单在编辑器里
  const previewDishes = dishes.slice(0, 3);
  // 后面的餐卡只给本餐合计：买菜前扫一眼就够（每道菜/逐食材的读数在大卡与编辑器里）
  const totalGrams = slot.portion?.dishes.reduce((sum, dish) => sum + dish.totalGrams, 0) ?? 0;
  const [nutritionOpen, setNutritionOpen] = useState(false);
  const [recipeOf, setRecipeOf] = useState<{ recipeId: string; name: string } | null>(null);

  // 卡内按钮的统一处理：先挡住整卡 Link 的跳转，再交给各自的 onClick
  const blockCardOpen = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <Link
        className={`card ${styles.ghostCard}`}
        to={`/slot/${slot.id}`}
        data-testid={decided ? 'ghost-slot-decided' : 'ghost-slot'}
        data-slot-id={slot.id}
      >
        <div className="spread">
          {/* 左列可收缩 + min-width:0：长菜名预告在常态下会很长，不这样右侧「已定」徽标
              会被 flex 挤成竖排（本票修的布局 bug） */}
          <span className={styles.ghostMain}>
            <b>
              {dayLabel(slot, today)} · {slot.meal === 'lunch' ? '午餐' : '晚餐'}
            </b>{' '}
            <span className="sub">
              {decided ? (
                previewDishes.length > 0 ? (
                  <>
                    {previewDishes.map((dish, index) => (
                      <Fragment key={dish.recipeId}>
                        {index > 0 ? '、' : ''}
                        <button
                          type="button"
                          className={styles.ghostDish}
                          data-testid={`ghost-dish-recipe-${dish.recipeId}`}
                          aria-haspopup="dialog"
                          aria-expanded={recipeOf?.recipeId === dish.recipeId}
                          aria-label={`${dish.name} 的食谱`}
                          onClick={(event) => {
                            blockCardOpen(event);
                            setRecipeOf({ recipeId: dish.recipeId, name: dish.name });
                          }}
                        >
                          {dish.name}
                        </button>
                      </Fragment>
                    ))}
                    {dishes.length > previewDishes.length ? ` 等 ${dishes.length} 道` : ''}
                    {totalGrams > 0 ? ` · 共 ${totalGrams} g` : ''}
                  </>
                ) : (
                  '已定'
                )
              ) : (
                '未定'
              )}
            </span>
          </span>
          <span className={decided ? `badge ok ${styles.ghostBadge}` : `badge ${styles.ghostBadge}`}>
            {decided ? '已定' : '点这定'}
          </span>
        </div>
        <div className={styles.ghostFoot}>
          {/* 掌勺者（本票）：后面的餐卡也少给一眼——点进卡片就能改 */}
          <span className={`sub ${styles.ghostCook}`} data-testid={`ghost-cook-${slot.id}`}>
            {slot.cook
              ? `👨‍🍳 ${slot.cook.name}`
              : decided
                ? '掌勺者：未指定'
                : slot.cookDefault
                  ? `👨‍🍳 ${slot.cookDefault.name}（照上一餐）`
                  : '掌勺者：未指定'}
          </span>
          {decided && slot.menu ? (
            <button
              type="button"
              className={styles.ghostNutrition}
              data-testid={`ghost-nutrition-${slot.id}`}
              aria-haspopup="dialog"
              aria-expanded={nutritionOpen}
              onClick={(event) => {
                blockCardOpen(event);
                setNutritionOpen(true);
              }}
            >
              📊 营养
            </button>
          ) : null}
        </div>
      </Link>
      {/* 面板是 `<a>` 的兄弟节点而不是子节点：弹层塞进链接里，点面板内容同样会触发跳转 */}
      {nutritionOpen ? <NutritionSheet slotId={slot.id} onClose={() => setNutritionOpen(false)} /> : null}
      {recipeOf ? (
        <RecipeSheet
          recipeId={recipeOf.recipeId}
          recipeName={recipeOf.name}
          onClose={() => setRecipeOf(null)}
        />
      ) : null}
    </>
  );
}

/** 这一餐菜单里正在冷藏期的菜（界面提示用） */
function cooledInMenu(slot: SlotWithPortion, cooling: CoolingDish[]): CoolingDish[] {
  const ids = new Set((slot.menu?.dishes ?? []).map((dish) => dish.recipeId));
  return cooling.filter((dish) => ids.has(dish.recipeId));
}

const KIND_LABEL: Record<string, string> = {
  meat: '荤',
  veg: '素',
  soup_meat: '汤',
  soup_veg: '汤',
};

/**
 * 「今天 / 明天 / 后天 / 6/5」。`today` 是**家庭时区**的今天（服务端下发），
 * 不用浏览器本地日期：家里在手机上看的「今天」跟餐槽判定用的「今天」必须是一天。
 */
export function dayLabel(slot: MealSlot, today: string | undefined): string {
  return dateLabel(slot.date, today);
}

/** 'YYYY-MM-DD' → 「今天 / 明天 / 后天 / 6/5」（相对今天；`today` 是**家庭时区**的服务端下发值） */
function dateLabel(date: string, today: string | undefined): string {
  if (!today) return date;
  const diff = daysBetween(today, date);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** 两个 'YYYY-MM-DD' 之间差几天（纯日期算术，不碰时区） */
export function daysBetween(from: string, to: string): number {
  const parse = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}