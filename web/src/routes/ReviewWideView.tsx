import { useCallback, useEffect, useState } from 'react';
import { useFeedback, type ReviewMeal } from '../api/feedback';
import { useRecipes } from '../api/recipes';
import type { PromotionResult } from '@dinnerorder/server/types';
import { useIdentity } from '../identity';
import { CoolingCard, LoadEarlier, ReviewCard, ReviewEmpty, ReviewHint } from './ReviewView';
import styles from './ReviewWideView.module.css';

/**
 * 平板版餐后回顾（#31）：**左列餐次列表 + 右列该餐的反馈与转正**。
 *
 * 手机版（`ReviewView`）是一条竖着的卡片流：找「上周三晚餐那道菜当时谁说了什么」要一张张往下滚。
 * 宽屏上把「选哪一餐」与「这一餐的吃后感」拆成两列：左列扫一遍所有吃过的餐（日期 + 餐次 +
 * 菜名 + 已有几条评价），点一下右列当场展开那一餐的全部反馈。
 *
 * 用的是与手机版**同一张卡** `ReviewCard`（点踩/点赞、快捷标签、整餐营养、单道菜谱、外部菜
 * 转正入口全都是它，story 33）：宽窄两个摆法在能力上不许有差。转正成功的回执也照旧挂在
 * **卡片这一层**（键是 `slotId:recipeId`，`ReviewView` 里那条同名注释解释了为什么）。
 *
 * 「更早的餐」（story 34）沿用同一份取数：首屏一页 + 「看更早的」逐页追加。宽版左列就是
 * 所有已取出页拼起来的一份列表（窄版是卡片流，宽版是列表——同一份餐、同一个顺序）。
 */
export function ReviewWideView() {
  const { current, members, isPending: identityPending } = useIdentity();
  const feedback = useFeedback();
  const recipes = useRecipes('all');
  const byId = new Map((recipes.data ?? []).map((recipe) => [recipe.id, recipe]));
  /** 转正回执：键 `${slotId}:${recipeId}`（与 `ReviewView` 同一口径） */
  const [promoted, setPromoted] = useState<Map<string, PromotionResult>>(new Map());
  /** 右列选中的那一餐；null = 跟随左列第一张 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 已翻开的更早的页（游标 → 那一页的餐与「还有更早的吗」），与左列顺序一致 */
  const [history, setHistory] = useState<string[]>([]);
  const [pages, setPages] = useState<Record<string, PageInfo>>({});

  const reportPage = useCallback((cursor: string, info: PageInfo) => {
    setPages((current) => (samePage(current[cursor], info) ? current : { ...current, [cursor]: info }));
  }, []);

  const meals = feedback.data?.meals ?? [];
  // 首页 + 已翻开页的餐拼成左列（顺序：先近后远，与手机版那条卡片流一致）
  const list = [...meals, ...history.flatMap((cursor) => pages[cursor]?.meals ?? [])];
  const selected = list.find((meal) => meal.slotId === selectedId) ?? list[0];

  // 「看更早的」挂在最后一页上：它的游标与「还有更早的吗」都来自那一页
  const lastCursor = history.at(-1);
  const tail = lastCursor ? pages[lastCursor] : undefined;
  const hasEarlier = lastCursor ? (tail?.hasEarlier ?? false) : (feedback.data?.hasEarlier ?? false);
  const olderThan = lastCursor ? (tail?.olderThan ?? undefined) : feedback.data?.olderThan;

  return (
    <div data-testid="review-view" data-layout-view="wide">
      <ReviewHint current={current} identityPending={identityPending} />

      {/* 每一页各自一个 `useFeedback`（hook 不能在循环里调）：它们只负责把这一页的餐报上来 */}
      {history.map((cursor) => (
        <HistoryProbe key={cursor} before={cursor} onLoaded={reportPage} />
      ))}

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
      ) : (
        <>
          <CoolingCard />

          {list.length === 0 ? (
            hasEarlier ? (
              // 首屏为空但还有更早的（与窄版 `review-older-only` 逐字相同）：说一句实情，
              // 别让这一页看起来「什么都没有」
              <div className="card sub" data-testid="review-older-only">
                这几天还没吃过——不过更早的餐往下能翻到。
              </div>
            ) : (
              /* 与窄版同一块（含「回今天」链接）：空态怎么说，不该因为摆法不同而不同 */
              <ReviewEmpty />
            )
          ) : (
            <div className={styles.columns}>
              {/* 左列：吃过的餐（点一格，右列换成那一餐） */}
              <div className={styles.list} data-testid="review-meals">
                {list.map((meal) => {
                  const isOn = selected?.slotId === meal.slotId;
                  return (
                    <button
                      key={meal.slotId}
                      type="button"
                      className={isOn ? `${styles.mealRow} ${styles.mealOn}` : styles.mealRow}
                      data-testid={`review-list-${meal.slotId}`}
                      data-slot-id={meal.slotId}
                      aria-pressed={isOn}
                      onClick={() => setSelectedId(meal.slotId)}
                    >
                      <span className={styles.mealTop}>
                        <b>
                          {meal.date} · {meal.meal === 'lunch' ? '午餐' : '晚餐'}
                        </b>
                        <span className="badge">{meal.feedback.length} 条</span>
                      </span>
                      <span className="sub">{meal.dishes.map((dish) => dish.name).join('、')}</span>
                    </button>
                  );
                })}
              </div>

              {/* 右列：选中那一餐的吃后感——就是手机版那一张卡，能力完全一样 */}
              <div className={styles.detail}>
                {selected ? (
                  <ReviewCard
                    key={selected.slotId}
                    meal={selected}
                    memberId={current?.id}
                    memberName={current?.name}
                    memberCount={members.length}
                    fallbackCook={current?.isCook ?? false}
                    recipes={byId}
                    promoted={promoted}
                    onPromoted={(result) =>
                      setPromoted((prev) => new Map(prev).set(`${selected.slotId}:${result.recipe.id}`, result))
                    }
                  />
                ) : null}
              </div>
            </div>
          )}

          {/* 「更早的餐」（story 34）：与手机版同一个 `LoadEarlier`——语义、文案、游标来源都一样，
              只是摆在左列列表下方（宽版不把历史卡片堆在屏幕上，翻页即换左列那一份列表）。
              有卡片时摆；**首屏为空但有更早的餐时也要摆**——那一屏正是最需要它的地方
              （不然「这几天还没吃过」就成了一句死话；窄版在同一情形下也摆它）。 */}
          {list.length > 0 || hasEarlier ? (
            <div className={styles.foot}>
              <LoadEarlier
                hasEarlier={hasEarlier}
                olderThan={olderThan}
                onLoad={(update) => {
                  setHistory((cursors) => update(cursors));
                  setSelectedId(null);
                }}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

interface PageInfo {
  meals: ReviewMeal[];
  hasEarlier: boolean;
  olderThan: string | undefined;
}

/** 一页更早的历史：只把这一页的餐与游标往上报，渲染在左列 */
function HistoryProbe({
  before,
  onLoaded,
}: {
  before: string;
  onLoaded: (cursor: string, info: PageInfo) => void;
}) {
  const feedback = useFeedback(before);
  const meals = feedback.data?.meals ?? [];
  const hasEarlier = feedback.data?.hasEarlier ?? false;
  const olderThan = feedback.data?.olderThan;

  useEffect(() => {
    if (feedback.isSuccess) onLoaded(before, { meals, hasEarlier, olderThan });
  }, [before, feedback.isSuccess, meals, hasEarlier, olderThan, onLoaded]);

  return null;
}

/** 两页内容是否相同（避免每次渲染都写一次 state 造成死循环） */
function samePage(a: PageInfo | undefined, b: PageInfo): boolean {
  return (
    a !== undefined &&
    a.hasEarlier === b.hasEarlier &&
    a.olderThan === b.olderThan &&
    a.meals.length === b.meals.length &&
    a.meals.every((meal, index) => meal === b.meals[index])
  );
}
