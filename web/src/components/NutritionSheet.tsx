import { Sheet } from './Sheet';
import { useSlotNutrition, type MenuNutrition } from '../api/nutrition';
import styles from './NutritionSheet.module.css';

/**
 * 整餐营养弹层（本票）：点餐槽卡上的「📊 营养」打开。
 *
 * 三件必须说清的事（都不是装饰）：
 * 1. **口径是整餐总量**，不是每人份——分母是「按 N 人算（Σ系数 ×）」。
 *    与旁边「共 N g」的整餐生重是同一份量，所以数字对得上；想换算成人均就再除一下。
 * 2. **缺数据的食材要看得见**（`missingIngredients`）：合计是「部分食材的合计」，
 *    不说出来家人会以为这餐就这么点热量。
 * 3. **是估算不是医学建议**（`nutritionSource`）：成分表是平均值、份量是生重、未计烹饪损耗。
 */
export function NutritionSheet({ slotId, onClose }: { slotId: string; onClose: () => void }) {
  const query = useSlotNutrition(slotId, true);

  return (
    <Sheet
      label="这一餐的营养"
      testId="nutrition-sheet"
      onClose={onClose}
      header={<b data-testid="nutrition-sheet-title">这一餐的营养</b>}
    >
      {query.isPending ? (
        <div className="sub" data-testid="nutrition-loading">
          正在算…
        </div>
      ) : query.isError ? (
        <div className={styles.error} data-testid="nutrition-error">
          {query.error instanceof Error ? query.error.message : '营养没算出来'}
        </div>
      ) : !query.data ? (
        <div className="sub" data-testid="nutrition-empty">
          这一餐还没定下来，没有营养可算。
        </div>
      ) : (
        <NutritionBody nutrition={query.data} />
      )}
    </Sheet>
  );
}

function NutritionBody({ nutrition }: { nutrition: MenuNutrition }) {
  const { energyKcal, proteinG, fatG, carbG } = nutrition;
  return (
    <div data-testid="nutrition-body">
      <div className={styles.hero}>
        <div className={styles.heroValue} data-testid="nutrition-energy">
          {format(energyKcal)} <span className={styles.heroUnit}>kcal</span>
        </div>
        <div className="sub" data-testid="nutrition-scope">
          这一餐合计 · 按 {nutrition.diners.length} 人算（Σ系数 ×{round(nutrition.factorSum)}
          {nutrition.uplift !== 1 ? ` · 留量上浮 ×${nutrition.uplift}` : ''}）
        </div>
      </div>

      <div className={styles.grid} data-testid="nutrition-macros">
        <Macro label="蛋白质" value={proteinG} testId="nutrition-protein" />
        <Macro label="脂肪" value={fatG} testId="nutrition-fat" />
        <Macro label="碳水" value={carbG} testId="nutrition-carb" />
      </div>

      {/* 缺口必须说出来：合计只含**有数据**的食材，不说就是让人以为「就这么点」 */}
      {nutrition.missingIngredients.length > 0 ? (
        <div className={styles.missing} data-testid="nutrition-missing">
          <b>部分食材没有营养数据</b>
          <div>
            {nutrition.missingIngredients.map((item) => item.name).join('、')} —— 这些没算进上面的数字，
            所以合计偏低。它们只是没录进成分表，不代表没有营养。
          </div>
        </div>
      ) : null}

      <div className={styles.dishes} data-testid="nutrition-dishes">
        {nutrition.dishes.map((dish) => (
          <div key={dish.recipeId} className={styles.dish} data-testid={`nutrition-dish-${dish.recipeId}`}>
            <div className={styles.dishRow}>
              <span>{dish.name}</span>
              <span className={styles.dishKcal}>{format(dish.energyKcal)} kcal</span>
            </div>
            <div className="sub">
              蛋白 {format(dish.proteinG)} g · 脂肪 {format(dish.fatG)} g · 碳水 {format(dish.carbG)} g
              {dish.partial ? ' · 这道里有食材没数据' : ''}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.source} data-testid="nutrition-note">
        {nutrition.nutritionSource}
      </div>
    </div>
  );
}

function Macro({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className={styles.macro} data-testid={testId}>
      <div className={styles.macroLabel}>{label}</div>
      <div className={styles.macroValue}>
        {format(value)} <span className={styles.macroUnit}>g</span>
      </div>
    </div>
  );
}

/** 一位小数就够（营养是估算值，展示更多位是假精度）；整数时不带小数点 */
export function format(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/** Σ系数展示到 3 位小数，抹掉浮点尾巴（1.7560000000000002 这种） */
function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
