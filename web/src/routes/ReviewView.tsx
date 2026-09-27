import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { useFamilyRules, useFeedback, type ReviewMeal } from '../api/feedback';
import { useRecipes } from '../api/recipes';
import { usePromoteRecipe } from '../api/promotion';
import type { PromotionResult, Recipe, RecipeCuisine } from '@dinnerorder/server/types';
import { useIdentity } from '../identity';
import type { Member } from '../api/members';
import { FeedbackBar } from '../components/FeedbackBar';
import { NutritionSheet } from '../components/NutritionSheet';
import { RecipeSheet } from '../components/RecipeSheet';
import styles from './ReviewView.module.css';

/**
 * 回顾页的**共用积木**（#31 抽出，手机单列与平板双列共用同一份）：
 *   * `ReviewHint` / `CoolingCard`——页头那两块提示；
 *   * `ReviewCard`——一餐的吃后感卡（点踩/点赞、快捷标签、营养、食谱、转正入口）；
 *   * `LoadEarlier`——「看更早的」（双列版的右列也沿用它，story 34）。
 *
 * 抽的是**积木**，不是页面骨架：`ReviewView`（窄）保持原来的单列组件树，
 * `ReviewWideView`（宽）自己搭「左列餐次列表 / 右列反馈详情」。
 */

/**
 * 餐后回顾（总纲 §2.5、CONTEXT「餐后回顾」）：饭后餐卡的常驻「吃后感」入口，
 * 也是 #21 转正（spec S6）的落点——总纲 §2.8 明写「外部菜谱被预定上桌 → 餐后回顾里
 * 掌勺者点「转正」」。
 *
 * 四条口径：
 *   * **常驻、不弹窗不推送**——它是底部导航的一个页，想看才点进来；吃完一顿系统不会主动跳出来。
 *   * **读者是掌勺者**：谁说了什么（「妈妈觉得不错」「小宝：太油」）都列出来——这条纪律写在
 *     `wire-types.ts` 的 `DishFeedback` 与任务书里；界面只是把它呈现出来。
 *     转正入口（本票改了判据）：**看的是「当前身份是不是这一餐的掌勺者」**（`meal.cook`），
 *     不是全局的 `isCook`——转正是「外部菜上桌后」的动作，该由**做了这一餐的人**决定。
 *     那一餐没指定掌勺者（NULL）时**回落到全局 `isCook`**（“没指定就按家里的习惯”）。
 *     无登录、无鉴权（总纲 §2.4：家庭 Wi-Fi 即门禁），这条约束靠 UI 引导。
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
  /**
   * 已经翻开的**更早的页**的游标（按时间从近到远）。空数组 = 只看首屏。
   * 数组而不是「一个当前游标」（本票：历史的每一餐）——翻过去的页要**留在屏幕上**，
   * 否则点「看更早的」会把眼前的卡片全推掉、再从头加载，家人得重滚一遍；
   * 而且已翻过的页各自有缓存（queryKey 带游标），翻回来不重拉。
   */
  const [history, setHistory] = useState<string[]>([]);
  const meals = feedback.data?.meals ?? [];

  return (
    <div data-testid="review-view">
      <ReviewHint current={current} identityPending={identityPending} />

      <CoolingCard />

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
      ) : meals.length === 0 && history.length === 0 && !(feedback.data?.hasEarlier ?? false) ? (
        <ReviewEmpty />
      ) : (
        <>
          <MealCards
            meals={meals}
            current={current}
            members={members}
            recipes={byId}
            promoted={promoted}
            onPromoted={(slotId, result) =>
              // 回执的键是**这张卡上的这道菜**（meal.slotId + recipeId），不是光一个 recipeId：
              // 同一道菜可能同时出现在两张回顾卡上（昨天的晚餐、今天的午餐），
              // 只用 recipeId 会让两张卡都显示「已转正」——而掌勺者只点过一次。
              setPromoted((prev) => new Map(prev).set(`${slotId}:${result.recipe.id}`, result))
            }
          />
          {/* 首屏为空但有更早的历史：说一句实情，别让这页看起来“什么都没有”。 */}
          {meals.length === 0 && history.length === 0 ? (
            <div className="card sub" data-testid="review-older-only">
              这几天还没吃过——不过更早的餐往下能翻到。
            </div>
          ) : null}
          {/* 历史页：每一页一个 `ReviewPage`（每页各自一个 `useFeedback`——hook 数稳定），
              页里面的卡片与首屏那批**完全同形**（含点踩/点赞/标签/转正入口）：
              「打分功能基于这份历史列表」是本票的前提，分页只能切开取数，不能切开能力。 */}
          {history.map((cursor) => (
            <ReviewPage
              key={cursor}
              before={cursor}
              current={current}
              members={members}
              recipes={byId}
              promoted={promoted}
              onPromoted={(slotId, result) =>
                setPromoted((prev) => new Map(prev).set(`${slotId}:${result.recipe.id}`, result))
              }
              onLoadEarlier={setHistory}
            />
          ))}
          {/* 「看更早的」只挂在**最后一个**已展开的页上：每页都挂一个会变成一排同名按钮，
              而它们做的事完全一样（都拿恰好自己那页的游标往更早翻）。 */}
          {history.length === 0 ? (
            <LoadEarlier
              hasEarlier={feedback.data?.hasEarlier ?? false}
              olderThan={feedback.data?.olderThan}
              onLoad={setHistory}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

export function ReviewHint({
  current,
  identityPending,
}: {
  current: Member | undefined;
  identityPending: boolean;
}) {
  const rules = useFamilyRules();
  // 家规还没读回来时不编一个数字（文案退到不写天数），读回来就是库里的真实值
  const coolOffDays = rules.data?.coolOffDays;
  return (
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
  );
}

/**
 * 冷藏期的菜（「这道为什么现在不推」的解释）。宽窄两版共用。
 * 家规从 `useFamilyRules` 读（与 `ReviewHint` 同一份缓存查询，不会多打接口）。
 */
export function CoolingCard() {
  const feedback = useFeedback();
  const rules = useFamilyRules();
  const cooling = feedback.data?.cooling ?? [];
  const coolOffDays = rules.data?.coolOffDays;
  if (cooling.length === 0) return null;
  return (
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
  );
}

/**
 * 「这几天还没吃过」空态（窄版与宽版共用，#31）——**含「回今天」那个链接**。
 *
 * 宽版最初自己写了一份，漏了这个链接：同一状态两个渲染点已经开始不一致。收成一处。
 * 没有更早的历史时才是这一块；还有历史时由调用方说「更早的餐往下能翻到」（那个形状两版不同，
 * 本该不同：窄版是「往下翻」的卡片流，宽版是一列列表）。
 */
export function ReviewEmpty() {
  return (
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
  );
}

/**
 * 一批回顾卡的渲染（首屏与历史页共用）。
 *
 * 抽出来而不是在 `ReviewView` 里写两遍：历史页的卡片必须与首屏**完全同形**
 * （本票的前提是「打分功能基于这份历史列表」）——两处各写一遍，改一边漏一边时
 * 就会变成「历史里的餐只能看、不能评」那种看不见的退化。
 */
function MealCards({
  meals,
  current,
  members,
  recipes,
  promoted,
  onPromoted,
}: {
  meals: ReviewMeal[];
  current: Member | undefined;
  members: Member[];
  recipes: Map<string, Recipe>;
  promoted: Map<string, PromotionResult>;
  onPromoted: (slotId: string, result: PromotionResult) => void;
}) {
  return (
    <>
      {meals.map((meal) => (
        <ReviewCard
          key={meal.slotId}
          meal={meal}
          memberId={current?.id}
          memberName={current?.name}
          memberCount={members.length}
          /* 全局 is_cook：那一餐**没指定**掌勺者时的回落（“没指定就按家里的习惯”） */
          fallbackCook={current?.isCook ?? false}
          recipes={recipes}
          promoted={promoted}
          onPromoted={(result) => onPromoted(meal.slotId, result)}
        />
      ))}
    </>
  );
}

/**
 * 一页更早的历史：一页一个 `useFeedback`（每页各自的游标就是它的 queryKey）。
 *
 * 为什么要一个子组件而不是在 `ReviewView` 里循环调 hook：hook 不能在循环里调。
 * 子组件把「一页」变成组件实例，每页的 hook 数就稳定了。
 */
function ReviewPage({
  before,
  current,
  members,
  recipes,
  promoted,
  onPromoted,
  onLoadEarlier,
}: {
  before: string;
  current: Member | undefined;
  members: Member[];
  recipes: Map<string, Recipe>;
  promoted: Map<string, PromotionResult>;
  onPromoted: (slotId: string, result: PromotionResult) => void;
  onLoadEarlier: (update: (cursors: string[]) => string[]) => void;
}) {
  const feedback = useFeedback(before);
  const meals = feedback.data?.meals ?? [];

  if (feedback.isPending) {
    return (
      <div className="card sub" data-testid="review-history-loading">
        正在读更早的…
      </div>
    );
  }
  // 读失败要说出来，而不是默默少一段：家人看到的是「历史到这就没了」，
  // 而实际上后面还有——那与真的到底了是两件事。
  if (feedback.isError) {
    return (
      <div className="card" data-testid="review-history-error">
        <b>更早的那一段没读回来</b>
        <div className="sub" style={{ marginTop: 6 }}>
          {feedback.error instanceof Error ? feedback.error.message : '检查一下网络或服务是不是停了。'}
        </div>
      </div>
    );
  }

  return (
    <>
      <MealCards
        meals={meals}
        current={current}
        members={members}
        recipes={recipes}
        promoted={promoted}
        onPromoted={onPromoted}
      />
      <LoadEarlier
        hasEarlier={feedback.data?.hasEarlier ?? false}
        olderThan={feedback.data?.olderThan}
        onLoad={onLoadEarlier}
      />
    </>
  );
}

/**
 * 「看更早的」：把下一页的游标追加进去。
 *
 * 游标用**服务端下发的** `olderThan`：前端算不出这个值——本页为空时没有「最后一餐」可用，
 * 而那种情形（这几天没吃过、但更早的吃过）恰恰只剩「看更早的」一条路。
 * 没有更早的（`hasEarlier` 为假）时按钮**换成一句实情**而不只是消失：
 * 「就这些了」与「没加载出来」在界面上是两件事。
 */
export function LoadEarlier({
  hasEarlier,
  olderThan,
  onLoad,
}: {
  hasEarlier: boolean;
  olderThan: string | undefined;
  onLoad: (update: (cursors: string[]) => string[]) => void;
}) {
  if (!olderThan) return null;
  if (!hasEarlier) {
    return (
      <div className="sub" data-testid="review-history-end" style={{ textAlign: 'center', margin: '14px 12px' }}>
        再往前就没有了——吃过的一餐都在这儿了。
      </div>
    );
  }
  return (
    <button
      type="button"
      className="btn ghost block"
      data-testid="review-load-earlier"
      style={{ marginTop: 8 }}
      onClick={() => onLoad((cursors) => [...cursors, olderThan])}
    >
      ⬆ 看更早的（历史里的每一餐都能评分）
    </button>
  );
}

/**
 * 菜名按钮：点一下开这道菜的食谱。
 *
 * **缩略态与展开态共用同一个组件**（本票）：两头都是食谱入口，只有在饮食谱的人才会觉得
 * 「换个状态食谱就不见了」。先前缩略态有个「等 N 道」的截断，而那几道在展开里又不是入口
 * ——那些菜的食谱就彻底不可达。
 *
 * `compact` 只是字号/颜色不同（缩略态作为行内菜名、展开态作为小标题），交互与语义完全相同。
 */
function DishNameButton({
  name,
  testId,
  expanded,
  onOpen,
  compact = false,
}: {
  name: string;
  testId: string;
  expanded: boolean;
  onOpen: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={compact ? `${styles.thumbDish} ${styles.nameLink}` : styles.name}
      data-testid={testId}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`${name} 的食谱`}
      onClick={onOpen}
    >
      {name}
    </button>
  );
}

/** 一餐的「吃后感」卡：吃过什么 + 每道菜的反馈（当前身份的那一条高亮回显）+ 草稿菜的转正入口 */
/**
 * 一餐的「吃后感」卡：吃过什么 + 每道菜的反馈（当前身份的那一条高亮回显）+ 草稿菜的转正入口。
 *
 * 导出给双列版（`ReviewWideView`）复用：右列就是这一张卡。**行为一字不改**——
 * 收起/展开、转正判据、反馈归属全照旧（story 33）。
 */
export function ReviewCard({
  meal,
  memberId,
  memberName,
  memberCount,
  fallbackCook,
  recipes,
  promoted,
  onPromoted,
}: {
  meal: ReviewMeal;
  memberId: string | undefined;
  memberName: string | undefined;
  memberCount: number;
  /** 全局 `is_cook`：那一餐没指定掌勺者时用它回落 */
  fallbackCook: boolean;
  recipes: Map<string, Recipe>;
  promoted: Map<string, PromotionResult>;
  onPromoted(result: PromotionResult): void;
}) {
  const mine = meal.feedback.filter((item) => item.memberId === memberId);
  const others = meal.feedback.filter((item) => item.memberId !== memberId);
  /**
   * 转正入口的可见性（本票改了判据）：**这一餐的掌勺者**才能转正。
   *
   * 转正是「外部菜上桌后」的动作，所以看的是**那一餐**的掌勺者，不是全局 `is_cook`；
   * 那一餐**没指定**（`meal.cook === null`）时回落到全局 `is_cook`（“没指定就按家里的习惯”）。
   * 而那个人可能已经被软删除（快照仍在）：这时 `memberId` 永远匹配不上，非掌勺者看不到入口。
   */
  const canPromote = meal.cook ? meal.cook.memberId === memberId : fallbackCook;
  /**
   * 展开/收起，**默认收起**（本票）：一张卡收起来只占一行，一屏能扫过好几天；
   * 展开才是「这一餐的吃后感」——那是评菜时才看的，不是扫历史时看的。
   *
   * 但**菜/食谱/营养在收起时就可达**（用户口径）：扫历史的人多半是“那顿到底吃了什么”，
   * 而不是“当时谁说了什么”。要是把菜名也藏在展开里，「翻历史」就得逐张点开。
   */
  const [open, setOpen] = useState(false);
  const [nutritionOpen, setNutritionOpen] = useState(false);
  const [recipeOf, setRecipeOf] = useState<{ recipeId: string; name: string } | null>(null);

  return (
    <div className="card" data-testid={`review-meal-${meal.slotId}`} data-slot-id={meal.slotId}>
      {/* 行头就是展开开关（与加菜器同一模式）：收起时它只报日期与道数 */}
      <button
        type="button"
        className={styles.head}
        data-testid={`review-toggle-${meal.slotId}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.headMain}>
          <b>
            {meal.date} · {meal.meal === 'lunch' ? '午餐' : '晚餐'}
          </b>
          <span className="sub">
            {meal.dishes.length} 道 · {meal.diners.map((diner) => diner.name).join('、')}
          </span>
        </span>
        <span className={styles.toggle}>{open ? '收起' : '展开'}</span>
      </button>

      {/* 菜与食谱（收起也看得到）：菜名本身就是食谱入口。
          **不截断**（本票修的缺口）：原来只列前三道、其余报「等 N 道」，
          而展开态的菜名又不是入口——那几道的食谱就彻底点不到了。
          一餐四五道，全列出来也就两行，比一个点不动的「等 2 道」有用。 */}
      <div className={styles.thumb} data-testid={`review-thumb-dishes-${meal.slotId}`}>
        {meal.dishes.map((dish, index) => (
          <Fragment key={dish.recipeId}>
            {index > 0 ? <span className="sub">、</span> : null}
            <DishNameButton
              compact
              name={dish.name}
              testId={`review-recipe-${meal.slotId}-${dish.recipeId}`}
              expanded={recipeOf?.recipeId === dish.recipeId}
              onOpen={() => setRecipeOf({ recipeId: dish.recipeId, name: dish.name })}
            />
          </Fragment>
        ))}
        {/* 营养（收起也看得到）：与今天页一样是一枚小按钮，按 slotId 现算 */}
        <button
          type="button"
          className={styles.thumbNutrition}
          data-testid={`review-nutrition-${meal.slotId}`}
          aria-haspopup="dialog"
          aria-expanded={nutritionOpen}
          onClick={() => setNutritionOpen(true)}
        >
          📊 营养
        </button>
      </div>

      {/* 已有的评价摘要：收起时也给一句——不然扫历史只看得出“那天吃了什么”，
          看不出“哪顿有人评过”。它只是摘要，逐道点评在展开里。 */}
      {!open && meal.feedback.length > 0 ? (
        <div className="sub" data-testid={`review-summary-${meal.slotId}`} style={{ marginTop: 6 }}>
          {meal.feedback.length} 条吃后感：
          {meal.feedback
            .map((item) => `${item.memberName}${item.verdict === 'like' ? '👍' : '👎'}`)
            .join(' ')}
        </div>
      ) : null}

      {open ? (
        <div className={styles.dishes}>
          {meal.dishes.map((dish) => {
            const mineHere = mine.find((item) => item.recipeId === dish.recipeId);
            const othersHere = others.filter((item) => item.recipeId === dish.recipeId);
            const recipe = recipes.get(dish.recipeId);
            return (
              <div key={dish.recipeId} className={styles.dish} data-testid={`review-dish-${dish.recipeId}`}>
                <div className={styles.dishHead}>
                  <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
                  {/* 展开态的菜名**也是**食谱入口（本票）：与缩略态同一个按钮。
                      只在缩略态给入口的话，家里换到展开态就会以为食谱不见了。 */}
                  <DishNameButton
                    name={dish.name}
                    testId={`review-dish-recipe-${meal.slotId}-${dish.recipeId}`}
                    expanded={recipeOf?.recipeId === dish.recipeId}
                    onOpen={() => setRecipeOf({ recipeId: dish.recipeId, name: dish.name })}
                  />
                </div>
                {/* 一个人都没说话时也把反馈条摆出来：这就是「常驻入口」的意思——不点二级页、不弹窗 */}
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
                    canPromote={canPromote}
                    onPromoted={onPromoted}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {nutritionOpen ? <NutritionSheet slotId={meal.slotId} onClose={() => setNutritionOpen(false)} /> : null}
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
 * 一道草稿菜的转正表单（spec S6 的落点）。
 *
 * 三件事在这里合流：
 *   * **只给这一餐的掌勺者**（`canPromote`）：转正改的是全家的菜谱库（别的餐次也会推荐它），
 *     不是随手拿了手机的人能决定的事。判据是**这一餐的掌勺者**（本票改了，原先是全局 `isCook`）
 *     ——转正是「外部菜上桌后」的动作，该由做了这一餐的人决定；那一餐没指定掌勺者时
 *     回落到全局 `is_cook`。非掌勺者看到一句说明，知道该找谁。
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
  canPromote,
  onPromoted,
}: {
  recipe: Recipe;
  memberId: string | undefined;
  /** 当前身份是不是**这一餐的掌勺者**（那一餐没指定时回落全局 `is_cook`） */
  canPromote: boolean;
  onPromoted(result: PromotionResult): void;
}) {
  const promote = usePromoteRecipe();
  const [open, setOpen] = useState(false);
  const [differences, setDifferences] = useState('');
  const [cuisine, setCuisine] = useState<string>(recipe.cuisine ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  const pending = recipe.ingredients.filter((item) => item.adultGrams <= 0);

  if (!canPromote) {
    return (
      <div className="sub" data-testid={`promote-cook-only-${recipe.id}`}>
        这道还是外部菜谱（没做过）——想让家里常做，让这一餐的掌勺者来点「转正」。
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
