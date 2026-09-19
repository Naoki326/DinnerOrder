import { useState } from 'react';
import { Link } from 'react-router';
import { apiBaseUrl } from '../config';
import { useHealth } from '../api/health';
import { useSlots, type MealSlot, type SlotWithPortion } from '../api/meals';
import {
  useAcceptRecommendation,
  useRecommendation,
  type MealRecommendation,
} from '../api/recommendations';
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

  const list = slots.data?.slots ?? [];
  const today = slots.data?.today;
  const next = list.find((slot) => slot.status === 'undecided') ?? list[0];
  const rest = list.filter((slot) => slot.id !== next?.id);

  return (
    <div data-testid="home-view">
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
        <HeroCard slot={next} today={today} />
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

/** 最近的一餐：定餐的入口（未定）或查看/改餐的入口（已定） */
function HeroCard({ slot, today }: { slot: SlotWithPortion; today: string | undefined }) {
  const decided = slot.status === 'decided';
  const [recommendation, setRecommendation] = useState<MealRecommendation | null>(null);
  const recommend = useRecommendation(slot.id);
  const accept = useAcceptRecommendation(slot.id);
  const [error, setError] = useState<string | undefined>(undefined);

  const request = (): void => {
    setError(undefined);
    recommend.mutate(
      {},
      {
        onSuccess: (result) => setRecommendation(result),
        onError: (cause) => setError(cause instanceof Error ? cause.message : '推荐失败'),
      },
    );
  };

  const acceptRecommendation = (): void => {
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
        // 接受成功后收起面板：菜单已经落库，卡片上会直接显示它（面板再挂在那儿是重复的）
        onSuccess: () => setRecommendation(null),
        onError: (cause) => setError(cause instanceof Error ? cause.message : '保存失败'),
      },
    );
  };

  return (
    <div className={`card ${styles.hero}`} data-testid="empty-slot" data-slot-id={slot.id}>
      <div className={styles.kicker}>{decided ? '最近这一餐' : '最近未定餐槽'}</div>
      <div className={styles.headline}>
        {dayLabel(slot, today)} · {slot.meal === 'lunch' ? '午餐' : '晚餐'}
        {decided ? <span className="badge ok"> 已定</span> : null}
      </div>

      {decided && slot.menu ? (
        <div className={styles.dishList} data-testid="hero-dishes">
          {slot.menu.dishes.map((dish) => {
            // 份量按菜品 index 对齐：列表接口内嵌的 portion.dishes 与 menu.dishes 同序同长
            // （都由 resolveDishes 按提交顺序产出），所以这里用下标取本餐生重
            const grams = slot.portion?.dishes.find((item) => item.recipeId === dish.recipeId)?.totalGrams;
            return (
              <div key={dish.recipeId} className={styles.dishRow}>
                <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
                <span>{dish.name}</span>
                {/* 只标「留量」不标倍数：上浮要等 #22 的「吃剩的」引用就位（总纲 §2.6：
                    上浮生效 = 留量标记 ∧ 有效引用）。现在写 ×1.5 会让家长以为买菜要多买 50%，
                    而引擎此刻恒不上浮（uplift=1）——标一个没兑现的倍数比不标更糟 */}
                {dish.keepLeftover ? <span className="badge">留量</span> : null}
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

      {recommendation ? (
        <RecommendationPanel
          recommendation={recommendation}
          pending={accept.isPending}
          onAccept={acceptRecommendation}
          onDiscard={() => setRecommendation(null)}
        />
      ) : null}

      {error ? (
        <div className={styles.recommendError} data-testid="recommend-error">
          {error}
        </div>
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
        <button type="button" className="btn ghost" disabled title="留量引用是后续工单">
          🌙 吃中午剩的
        </button>
      </div>
      <div className="sub" style={{ marginTop: 10 }}>
        手动挑菜按同一条编辑路径走；「给我推荐」按这餐的人、忌口与时令现配一份。
      </div>
    </div>
  );
}

/**
 * 推荐面板：结构摘要 + 每道菜的理由 + 「没做过」+ 一键接受。
 *
 * 两处「显著标记」是 spec 的硬要求，不是装饰：
 *   * 外部补位菜标「没做过」（spec S6）——家人要知道这盘菜家里没做过；
 *   * 简化推荐标警示条（spec S7）——LLM 没参与时必须说清，否则家人会以为那是模型配的。
 */
function RecommendationPanel({
  recommendation,
  pending,
  onAccept,
  onDiscard,
}: {
  recommendation: MealRecommendation;
  pending: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const simplified = recommendation.llm.format === 'rules_only';
  const structure = recommendation.structure;

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
          <div key={dish.recipeId} className={styles.recommendDish} data-testid={`recommend-dish-${dish.recipeId}`}>
            <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
            <span className={styles.recommendName}>
              {dish.name}
              {dish.origin === 'external' ? (
                <span className="badge" data-testid={`recommend-external-${dish.recipeId}`}>
                  没做过
                </span>
              ) : null}
            </span>
            <span className={styles.recommendReason}>{dish.reason ?? '规则直接拼的，没有理由'}</span>
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

/** 往下的餐槽：未定/已定都列出来，点了就进编辑器 */
function GhostCard({ slot, today }: { slot: SlotWithPortion; today: string | undefined }) {
  const decided = slot.status === 'decided';
  const dishes = slot.menu?.dishes ?? [];
  const preview = dishes.slice(0, 3).map((dish) => dish.name).join('、');
  // 后面的餐卡只给本餐合计：买菜前扫一眼就够（每道菜/逐食材的读数在大卡与编辑器里）
  const totalGrams = slot.portion?.dishes.reduce((sum, dish) => sum + dish.totalGrams, 0) ?? 0;

  return (
    <Link
      className={`card ${styles.ghostCard}`}
      to={`/slot/${slot.id}`}
      data-testid={decided ? 'ghost-slot-decided' : 'ghost-slot'}
      data-slot-id={slot.id}
    >
      <div className="spread">
        <span>
          <b>
            {dayLabel(slot, today)} · {slot.meal === 'lunch' ? '午餐' : '晚餐'}
          </b>{' '}
          <span className="sub">
            {decided ? preview || '已定' : '未定'}
            {decided && totalGrams > 0 ? ` · 共 ${totalGrams} g` : ''}
          </span>
        </span>
        <span className={decided ? 'badge ok' : 'badge'}>{decided ? '已定' : '点这定'}</span>
      </div>
    </Link>
  );
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
  if (!today) return slot.date;
  const diff = daysBetween(today, slot.date);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return `${Number(slot.date.slice(5, 7))}/${Number(slot.date.slice(8, 10))}`;
}

/** 两个 'YYYY-MM-DD' 之间差几天（纯日期算术，不碰时区） */
export function daysBetween(from: string, to: string): number {
  const parse = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}