import { Link } from 'react-router';
import { useFamilyRules, useFeedback, type ReviewMeal } from '../api/feedback';
import { useIdentity } from '../identity';
import { FeedbackBar } from '../components/FeedbackBar';
import styles from './ReviewView.module.css';

/**
 * 餐后回顾（总纲 §2.5、CONTEXT「餐后回顾」）：饭后餐卡的常驻「吃后感」入口。
 *
 * 三条口径：
 *   * **常驻、不弹窗不推送**——它是底部导航的一个页，想看才点进来；吃完一顿系统不会主动跳出来。
 *   * **读者是掌勺者**：谁说了什么（「妈妈觉得不错」「小宝：太油」）都列出来——这条纪律写在
 *     `wire-types.ts` 的 `DishFeedback` 与任务书里；界面只是把它呈现出来。
 *   * **点踩的后果要说清**：踩完当场提示「这道菜 N 天内不再进推荐」——N 从家规读
 *     （`useFamilyRules` → `GET /api/family-rules` 的 `coolOffDays`），不把 14 硬编码进文案，
 *     家人知道自己的这一下真的有用。
 *   * **标签与判定解耦**（总纲 §2.5 原文：「餐后回顾：点踩/点赞 + 同套快捷标签」）：
 *     所以这里给 `FeedbackBar` 传 `tagsOnLike`——菜单卡那一路仍只在点踩时摆标签。
 *
 * 反馈归属**当前身份**（无登录）：切了身份就是另一个人在说话——头像条常驻在页顶部。
 */
export function ReviewView() {
  const { current, members, isPending: identityPending } = useIdentity();
  const feedback = useFeedback();
  const rules = useFamilyRules();
  const meals = feedback.data?.meals ?? [];
  const cooling = feedback.data?.cooling ?? [];
  // 家规还没读回来时不编一个数字（文案退到不写天数），读回来就是库里的真实值
  const coolOffDays = rules.data?.coolOffDays;

  return (
    <div data-testid="review-view">
      <div className={`card ${styles.hint}`}>
        <div className="spread">
          <b>餐后回顾</b>
          <span className="sub">
            当前身份：{current ? `${current.emoji} ${current.name}` : identityPending ? '…' : '未选'}
          </span>
        </div>
        <div className="sub" data-testid="review-hint" style={{ marginTop: 6 }}>
          吃过的一餐在这里说说感受（不弹窗、不推送）：点赞给推荐当软信号；
          点踩会让这道菜进冷藏期{coolOffDays ? `（家规 ${coolOffDays} 天）` : ''}，暂时不再推。
        </div>
      </div>

      {cooling.length > 0 ? (
        <div className="card" data-testid="cooling-list">
          <div className="spread">
            <b>冷藏期的菜</b>
            <span className="badge warn">暂时不推</span>
          </div>
          <div className="sub" style={{ marginTop: 6 }} data-testid="cooling-hint">
            有人点过踩——这些菜在冷藏期{coolOffDays ? `（家规 ${coolOffDays} 天）` : ''}内不进推荐与换菜候选，到期自动解除。
          </div>
          <ul className={styles.cooling}>
            {cooling.map((dish) => (
              <li key={dish.recipeId} data-testid={`cooling-${dish.recipeId}`}>
                <span>{dish.name}</span>
                <span className="sub">{dish.until} 起可以再推</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {feedback.isPending ? (
        <div className="card sub" data-testid="review-loading">
          读取中…
        </div>
      ) : feedback.isError ? (
        <div className="card" data-testid="review-error">
          <b>回顾没读回来</b>
          <div className="sub" style={{ marginTop: 6 }}>
            {feedback.error instanceof Error ? feedback.error.message : '检查一下网络或服务是不是停了。'}
          </div>
        </div>
      ) : meals.length === 0 ? (
        <div className="card" data-testid="review-empty">
          <b>这几天还没有吃过的一餐</b>
          <div className="sub" style={{ marginTop: 6 }}>
            吃过的餐会出现在这里（今天起往回看三天）。没定的餐 app 不追踪、不提醒。
          </div>
          <div style={{ marginTop: 10 }}>
            <Link className="btn ghost" to="/">
              回今天
            </Link>
          </div>
        </div>
      ) : (
        meals.map((meal) => (
          <ReviewCard
            key={meal.slotId}
            meal={meal}
            memberId={current?.id}
            memberName={current?.name}
            memberCount={members.length}
          />
        ))
      )}
    </div>
  );
}

/** 一餐的「吃后感」卡：吃过什么 + 每道菜的反馈（当前身份的那一条高亮回显） */
function ReviewCard({
  meal,
  memberId,
  memberName,
  memberCount,
}: {
  meal: ReviewMeal;
  memberId: string | undefined;
  memberName: string | undefined;
  memberCount: number;
}) {
  const mine = meal.feedback.filter((item) => item.memberId === memberId);
  const others = meal.feedback.filter((item) => item.memberId !== memberId);

  return (
    <div className="card" data-testid={`review-meal-${meal.slotId}`} data-slot-id={meal.slotId}>
      <div className="spread">
        <b>
          {meal.date} · {meal.meal === 'lunch' ? '午餐' : '晚餐'}
        </b>
        <span className="badge">
          {meal.dishes.length} 道 · {meal.diners.map((diner) => diner.name).join('、')}
        </span>
      </div>

      <div className={styles.dishes}>
        {meal.dishes.map((dish) => {
          const mineHere = mine.find((item) => item.recipeId === dish.recipeId);
          const othersHere = others.filter((item) => item.recipeId === dish.recipeId);
          return (
            <div key={dish.recipeId} className={styles.dish} data-testid={`review-dish-${dish.recipeId}`}>
              <div className={styles.dishHead}>
                <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
                <span className={styles.name}>{dish.name}</span>
              </div>
              {/* 一个人都没说话时也把反馈条摆出来：这就是「常驻入口」的意思——不点进二级页、不弹窗 */}
              {memberId ? (
                <FeedbackBar
                  slotId={meal.slotId}
                  recipeId={dish.recipeId}
                  recipeName={dish.name}
                  memberId={memberId}
                  memberName={memberName}
                  current={mineHere}
                  // testid 带餐槽：同一道菜可能同时出现在两张回顾卡上（昨天的晚餐、今天的午餐），
                  // 只用菜谱 id 会让 testid 撞车——#21 的转正入口也要靠这层前缀区分
                  testIdPrefix={`review-${meal.date}-${meal.meal}`}
                  // 餐后回顾那一路：点赞也能贴同套标签（总纲 §2.5 原文两句不同，见组件注释）
                  tagsOnLike
                />
              ) : (
                <div className="sub" data-testid="review-need-identity">
                  {memberCount === 0 ? '还没有家人，先去「家人」页添加' : '先选一个当前身份（右上角头像）再说感受'}
                </div>
              )}
              {othersHere.length > 0 ? (
                <div className="sub" data-testid={`review-others-${dish.recipeId}`}>
                  {othersHere
                    .map((item) => `${item.memberName}：${verdictLabel(item)}`)
                    .join('；')}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 别人说了什么：一句话说清（标签跟在判定后面） */
function verdictLabel(item: { verdict: 'like' | 'dislike'; tags: string[] }): string {
  const base = item.verdict === 'like' ? '👍 觉得不错' : '👎 不太满意';
  return item.tags.length > 0 ? `${base}（${item.tags.join('、')}）` : base;
}

const KIND_LABEL: Record<string, string> = { meat: '荤', veg: '素', soup_meat: '汤', soup_veg: '汤' };
