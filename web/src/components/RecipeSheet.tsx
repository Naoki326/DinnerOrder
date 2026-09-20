import { useRecipeDetail } from '../api/nutrition';
import type { DishIngredientPortion } from '../api/portion';
import { Sheet } from './Sheet';
import styles from './RecipeSheet.module.css';

/**
 * 单道菜食谱弹层（本票）：点菜行上的「食谱」打开。
 *
 * 内容两件（用户口径）：**做法步骤**（`recipes.steps` 原文，自由文本、可能多行带序号）
 * + **食材清单**。
 *
 * 清单的克数怎么给：在编辑器（`SlotView`）里传了本餐份量，就同时给「成人份基准」与
 * 「本餐生重」——家人站在灶台前要知道**这一锅**放多少；在大卡/首页那种没有逐食材份量的地方
 * 只给成人份基准（食谱本身的口径）。两者都标清楚，不混着说。
 *
 * `steps` 为空串时**明确说「这道还没写做法」**，不显示一个空框（家庭菜里确实有没写的）。
 */
export function RecipeSheet({
  recipeId,
  recipeName,
  dishIngredients,
  onClose,
}: {
  recipeId: string;
  recipeName: string;
  /** 本餐逐食材克数（有就给「本餐生重」那一列；没有就只显示成人份基准） */
  dishIngredients?: DishIngredientPortion[];
  onClose: () => void;
}) {
  const query = useRecipeDetail(recipeId);

  return (
    <Sheet
      label={`${recipeName} 的食谱`}
      testId="recipe-sheet"
      onClose={onClose}
      header={<b data-testid="recipe-sheet-title">{recipeName} 的食谱</b>}
    >
      {query.isPending ? (
        <div className="sub" data-testid="recipe-loading">
          正在读做法…
        </div>
      ) : query.isError ? (
        <div className={styles.error} data-testid="recipe-error">
          {query.error instanceof Error ? query.error.message : '做法没读回来'}
        </div>
      ) : !query.data ? null : (
        <div data-testid="recipe-body">
          <div className={styles.sectionLabel}>做法</div>
          {query.data.steps.trim() === '' ? (
            <div className="sub" data-testid="recipe-no-steps">
              这道还没写做法。
            </div>
          ) : (
            // `white-space: pre-wrap`：steps 是多行自由文本（外部池的步骤带「1. 2. 3.」序号），
            // 换行要照原样渲染；`overflow-wrap: anywhere` 保证长行不会把手机撑宽
            <div className={styles.steps} data-testid="recipe-steps">
              {query.data.steps}
            </div>
          )}

          <div className={styles.sectionLabel}>食材（成人份）</div>
          {query.data.ingredients.length === 0 ? (
            <div className="sub" data-testid="recipe-no-ingredients">
              这道还没录食材。
            </div>
          ) : (
            <div className={styles.ingredients} data-testid="recipe-ingredients">
              {query.data.ingredients.map((item) => {
                const actual = dishIngredients?.find((entry) => entry.ingredientId === item.ingredientId);
                return (
                  <div
                    key={item.ingredientId}
                    className={styles.ingredient}
                    data-testid={`recipe-ingredient-${item.ingredientId}`}
                  >
                    <span className={styles.ingredientName}>{item.name}</span>
                    <span className={styles.ingredientGrams}>
                      {item.adultGrams} g
                      {item.scaling === 'fixed' ? <span className={styles.fixedTag}>一锅</span> : null}
                      {/* 有本餐份量时并排列出「这一锅」的量：两个数上下对比，不混着说 */}
                      {actual !== undefined && actual.grams !== item.adultGrams ? (
                        <span className={styles.actual} data-testid={`recipe-grams-${item.ingredientId}`}>
                          （本餐 {actual.grams} g）
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className={styles.note}>克数是生重；「一锅」标记的调料不随人数放大。</div>
        </div>
      )}
    </Sheet>
  );
}
