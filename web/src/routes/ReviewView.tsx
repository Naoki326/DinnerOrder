import { useState } from 'react';
import { Link } from 'react-router';
import { useFamilyRules, useFeedback, type ReviewMeal } from '../api/feedback';
import { useRecipes } from '../api/recipes';
import { usePromoteRecipe } from '../api/promotion';
import type { PromotionResult, Recipe, RecipeCuisine } from '@dinnerorder/server/types';
import { useIdentity } from '../identity';
import { FeedbackBar } from '../components/FeedbackBar';
import styles from './ReviewView.module.css';

/**
 * 餐后回顾（总纲 §2.5、CONTEXT「餐后回顾」）：饭后餐卡的常驻「吃后感」入口，
 * 也是 #21 转正（spec S6）的落点——总纲 §2.8 明写「外部菜谱被预定上桌 → 餐后回顾里
 * 掌勺者点「转正」」。
 *
 * 四条口径：
 *   * **常驻、不弹窗不推送**——它是底部导航的一个页，想看才点进来；吃完一顿系统不会主动跳出来。
 *   * **读者是掌勺者**：谁说了什么（「妈妈觉得不错」「小宝：太油」）都列出来——这条纪律写在
 *     `wire-types.ts` 的 `DishFeedback` 与任务书里；界面只是把它呈现出来。
 *     转正入口同理只给掌勺者看（`current.isCook`）：改的是全家的菜谱库，不该由随手拿了
 *     手机的人决定。无登录、无鉴权（总纲 §2.4：家庭 Wi-Fi 即门禁），这条约束靠 UI 引导。
 *   * **点踩的后果要说清**：踩完当场提示「这道菜 N 天内不再进推荐」——N 从家规读
 *     （`useFamilyRules` → `GET /api/family-rules` 的 `coolOffDays`），不把 14 硬编码进文案。
 *   * **标签与判定解耦**（总纲 §2.5 原文：「餐后回顾：点踩/点赞 + 同套快捷标签」）：
 *     所以这里给 `FeedbackBar` 传 `tagsOnLike`——菜单卡那一路仍只在点踩时摆标签。
 *
 * 反馈归属**当前身份**（无登录）：切了身份就是另一个人在说话——头像条常驻在页顶部。
 */
export function ReviewView() {
  const { current, members, isPending: identityPending } = useIdentity();
  const feedback = useFeedback();
  const rules = useFamilyRules();
  // 菜谱是**一份共享缓存**（`['recipes','all']`）：转正表单要知道每道菜的 status / cuisine /
  // 有没有待重标项，而这些都在菜谱上。走同一份 useRecipes 而不是另开一个「可转正菜」接口：
  // 同一道菜在两处显示同一份数据，才不会有第二个真相。
  const recipes = useRecipes('all');
  const byId = new Map((recipes.data ?? []).map((recipe) => [recipe.id, recipe]));
  // 刚转正的那些：回执挂在**卡片这一层**而不是表单里面。表单会在菜谱缓存刷新后随
  // 「不再是草稿」一起消失，回执跟着消失的话，家人根本看不到自己刚做了什么。
  // 键是 `${slotId}:${recipeId}` 而不是光一个 `recipeId`：同一道菜可能同时出现在两张回顾卡上
  // （昨天的晚餐、今天的午餐），只用菜谱 id 会让两张卡都跳出「已转正」（见 ReviewCard 的用法）。
  const [promoted, setPromoted] = useState<Map<string, PromotionResult>>(new Map());
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
            isCook={current?.isCook ?? false}
            recipes={byId}
            promoted={promoted}
            onPromoted={(result) =>
              // 回执的键是**这张卡上的这道菜**（meal.slotId + recipeId），不是光一个 recipeId：
              // 同一道菜可能同时出现在两张回顾卡上（昨天的晚餐、今天的午餐），
              // 只用 recipeId 会让两张卡都显示「已转正」——而掌勺者只点过一次。
              setPromoted((prev) => new Map(prev).set(`${meal.slotId}:${result.recipe.id}`, result))
            }
          />
        ))
      )}
    </div>
  );
}

/** 一餐的「吃后感」卡：吃过什么 + 每道菜的反馈（当前身份的那一条高亮回显）+ 草稿菜的转正入口 */
function ReviewCard({
  meal,
  memberId,
  memberName,
  memberCount,
  isCook,
  recipes,
  promoted,
  onPromoted,
}: {
  meal: ReviewMeal;
  memberId: string | undefined;
  memberName: string | undefined;
  memberCount: number;
  isCook: boolean;
  recipes: Map<string, Recipe>;
  promoted: Map<string, PromotionResult>;
  onPromoted(result: PromotionResult): void;
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
          const recipe = recipes.get(dish.recipeId);
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
                  // 只用菜谱 id 会让 testid 撞车——#21 的转正入口靠外层卡片定位区分
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
              {/* 转正入口（总纲 §2.8 / spec S6）：只对**还没转正的外部菜**（草稿）出现；
                  `recipe` 还没读回来时什么都不摆——宁可晚一拍，也不给一个按下去会 409 的按钮 */}
              {promoted.has(`${meal.slotId}:${dish.recipeId}`) ? (
                <PromotedReceipt result={promoted.get(`${meal.slotId}:${dish.recipeId}`)!} />
              ) : recipe && recipe.status === 'draft' ? (
                <PromotionForm
                  recipe={recipe}
                  memberId={memberId}
                  isCook={isCook}
                  onPromoted={onPromoted}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 一道草稿菜的转正表单（spec S6 的落点）。
 *
 * 三件事在这里合流：
 *   * **只给掌勺者**（`isCook`）：转正改的是全家的菜谱库（别的餐次也会推荐它），
 *     不是随手拿了手机的人能决定的事。非掌勺者看到一句说明，知道该找谁。
 *   * **待重标要看得见**（#19 台账点名交给 #21）：0 克项来自导入期的模糊份量
 *     （「适量」等 LLM 重标，迁移 005）。转正会把克数固化成家庭基准，所以先把它们列出来——
 *     LLM 会在改写时把它们重标掉（服务端保证：转正后的菜谱没有 0 克项）；
 *     注意它与「掌勺者口述不放某食材」是两回事（后者是这次改写的结论，落库时那一项被丢掉），
 *     所以界面上不把两者说成同一件事。
 *   * **菜系要能校对**（总纲 §2.8：「导入时 LLM 初打、转正时掌勺者校对」）：
 *     值域是封闭集合，所以下拉框的选项要照着来。**前端不 import 服务端的 `CUISINES`**
 *     ——那是运行时常量（web 只允许从 `@dinnerorder/server/types` 取**类型**，ADR-0002），
 *     所以这里照抄一份（与 `FeedbackBar` 的 `FEEDBACK_TAG_OPTIONS` 同一处理：
 *     顺序与选项是界面的事，值域本身由服务端的 CHECK 与 zod 兜底）。
 */
function PromotionForm({
  recipe,
  memberId,
  isCook,
  onPromoted,
}: {
  recipe: Recipe;
  memberId: string | undefined;
  isCook: boolean;
  onPromoted(result: PromotionResult): void;
}) {
  const promote = usePromoteRecipe();
  const [open, setOpen] = useState(false);
  const [differences, setDifferences] = useState('');
  const [cuisine, setCuisine] = useState<string>(recipe.cuisine ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  const pending = recipe.ingredients.filter((item) => item.adultGrams <= 0);

  if (!isCook) {
    return (
      <div className="sub" data-testid={`promote-cook-only-${recipe.id}`}>
        这道还是外部菜谱（没做过）——想让家里常做，让掌勺者来点「转正」。
      </div>
    );
  }

  // 成功后菜谱查询被失效重取，status 翻到 active → 表单随「不再是草稿」一起消失，
  // 回执由外层卡片接管（`onPromoted` 把结果提上去，见 ReviewView 的 `promoted`）
  if (promote.isSuccess) return null;

  return (
    <div className={styles.promote} data-testid={`promote-${recipe.id}`}>
      {!open ? (
        <button
          type="button"
          className="btn ghost"
          data-testid={`promote-open-${recipe.id}`}
          disabled={!memberId}
          onClick={() => setOpen(true)}
        >
          转正成家里菜谱
        </button>
      ) : (
        <>
          <div className="sub">
            {recipe.source === 'howtocook' ? '来自 HowToCook' : recipe.source === 'scraped' ? '来自下厨房' : '外部菜谱'}
            {recipe.cuisine ? ` · 菜系 ${recipe.cuisine}` : ' · 菜系未标'}
            {pending.length > 0 ? ` · 还有 ${pending.length} 项份量待重标` : ''}
          </div>
          {pending.length > 0 ? (
            <div className="sub" data-testid={`promote-pending-${recipe.id}`}>
              待重标：{pending.map((item) => item.name).join('、')}（转正时由 LLM 换成克数）
            </div>
          ) : null}
          <textarea
            className={styles.textarea}
            value={differences}
            placeholder="这次的做法和原谱有什么不一样？（如：多点辣、不放蒜）"
            aria-label={`${recipe.name}的做法差异`}
            data-testid={`promote-differences-${recipe.id}`}
            rows={2}
            onChange={(event) => setDifferences(event.target.value)}
          />
          <label className={styles.cuisine}>
            <span className="sub">菜系</span>
            <select
              aria-label={`${recipe.name}的菜系`}
              data-testid={`promote-cuisine-${recipe.id}`}
              value={cuisine}
              onChange={(event) => setCuisine(event.target.value)}
            >
              <option value="">不标</option>
              {CUISINE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              type="button"
              className="btn"
              data-testid={`promote-submit-${recipe.id}`}
              disabled={promote.isPending || !memberId}
              onClick={() => {
                setError(undefined);
                promote.mutate(
                  {
                    recipeId: recipe.id,
                    input: {
                      ...(differences.trim() === '' ? {} : { differences: differences.trim() }),
                      ...(cuisine === '' ? {} : { cuisine: cuisine as RecipeCuisine }),
                      ...(memberId === undefined ? {} : { memberId }),
                    },
                  },
                  {
                    onSuccess: onPromoted,
                    onError: (cause) => setError(cause instanceof Error ? cause.message : '转正没成功'),
                  },
                );
              }}
            >
              {promote.isPending ? '改写中…' : '转正'}
            </button>
            <button
              type="button"
              className="btn ghost"
              data-testid={`promote-cancel-${recipe.id}`}
              disabled={promote.isPending}
              onClick={() => {
                setOpen(false);
                setError(undefined);
              }}
            >
              算了
            </button>
          </div>
          {error ? (
            <div className={styles.error} data-testid={`promote-error-${recipe.id}`}>
              {error}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * 转正成功的回执（挂在回顾卡上）：点完按钮界面不应该一闪就完事——家人要看得见
 * 「刚做了什么、改成了什么样」。回执本身是**本页状态**（不落库）：刷新页面后菜谱已经是
 * 家庭菜谱了（状态就是回执），不需要一条「曾经转正过」的记录再读一遍。
 */
function PromotedReceipt({ result }: { result: PromotionResult }) {
  return (
    <div className={styles.promoteResult} data-testid={`promoted-${result.recipe.id}`}>
      <span className="badge ok">已转正</span>
      <span className="sub">
        进家庭库与推荐池了（{result.llm.model} 改写，{result.recipe.ingredients.length} 项食材）
      </span>
    </div>
  );
}

/** 别人说了什么：一句话说清（标签跟在判定后面） */
function verdictLabel(item: { verdict: 'like' | 'dislike'; tags: string[] }): string {
  const base = item.verdict === 'like' ? '👍 觉得不错' : '👎 不太满意';
  return item.tags.length > 0 ? `${base}（${item.tags.join('、')}）` : base;
}

const KIND_LABEL: Record<string, string> = { meat: '荤', veg: '素', soup_meat: '汤', soup_veg: '汤' };

/**
 * 菜系下拉的选项表（总纲 §2.8 的封闭集合：中国菜系里家常菜真会落到的那几个 + 「家常」）。
 * 与服务的 `CUISINES`（`server/src/llm/import-schema.ts`）**值域同源**，这里只决定界面上的
 * 排列顺序——web 不能 import 运行时常量（ADR-0002 只放开类型），所以是照抄而不是引用。
 * 真正的把关在服务端：zod 的 `z.enum(CUISINES)` 与迁移 005 的 CHECK。
 */
const CUISINE_OPTIONS: RecipeCuisine[] = ['家常', '川', '粤', '鲁', '苏浙', '湘', '东北', '闽', '徽', '西北', '京'];
