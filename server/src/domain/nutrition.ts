import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type {
  DishNutrition,
  DishNutritionIngredient,
  IngredientNutrition,
  MenuNutrition,
  RecipeDetail,
} from '../wire-types.js';
import { portionOf, type PortionInput, type PortionOptions } from './portion.js';
import { RecipeNotFoundError } from './promotion.js';
import { findRecipe } from './recipes.js';
import { isEstimatedNutritionSource } from '../llm/nutrition-estimate-schema.js';
import { ingredientNutritionRow, type NutritionTableRow } from './ingredient-nutrition.js';

/**
 * 每餐营养（本票）：Σ(portionOf 给出的逐食材本餐克数 ÷ 100 × 每 100 g 营养)。
 *
 * 三条口径先说清：
 *
 * 1. **必须复用 `portionOf`**，不自己重算份量。营养的输入就是份量的输出（`DishPortion.ingredients`
 *    的 `grams`），所以留量上浮（#22）与年龄分带折算（#16）**自动**进到营养里——份量改了，
 *    营养跟着改，两边不可能各说各的。这也让「有留量引用 vs 没有」的营养差可被测试证明。
 * 2. **缺数据不当 0**。某食材没有营养行时，那一项计入 `null` 并且**不进合计**，同时整餐
 *    带 `missingIngredients`——界面必须把它说出来（本仓纪律：异常原因看得见）。
 *    选「部分合计 + 明示缺口」而不是「整餐拒绝计算」，理由：一餐里只要有一味平台查不到的
 *    香料（八角、香叶）就把整餐的营养读数全废掉，等于这个功能对**真实菜单**永远不可用；
 *    而「缺数据的食材按 0 计的合计 + 一句『这几味没有数据』」给出的数是**下界**，
 *    方向上不会骗人（缺的只会让真实值更高）。整餐拒绝计算只在「主力食材缺数据」时才诚实，
 *    但那种情况在界面上与「一味香料缺数据」无法区分，做不到——所以统一用「部分合计 + 明示」。
 *
 *    本票（#38）之后**多了一种「有数据但不是读数」的项**：估算行（ADR-0013）。它与缺数据的
 *    后果完全不同——估算**已进合计**，数字是**参考**而不是偏低。所以两者分开报
 *    （`missingIngredients` / `estimatedIngredients`），`partial` 的语义扩成「合计不是全由
 *    读数构成」（CONTEXT「部分食材的合计」）。
 * 3. **口径是整餐总量**（本餐全部生重的合计），不是「每人份」。分母是 `portion.factorSum`：
 *    界面在合计旁写「按 N 人算（Σ系数 ×）」就是让数字可复算——想换算成人均就再除一下。
 *    写成「每人份」会与旁边「共 475 g」的整餐生重对不上（那份量是整餐的量）。
 */
export function nutritionOf(
  db: Db,
  clock: Clock,
  input: PortionInput,
  options: PortionOptions = {},
): MenuNutrition {
  const portion = portionOf(db, clock, input, options);
  const facts = nutritionTable(db);
  const missing = new Map<string, string>();
  const estimated = new Map<string, string>();

  const dishes: DishNutrition[] = portion.dishes.map((dish) => {
    const ingredients: DishNutritionIngredient[] = dish.ingredients.map((item) => {
      const per100g = facts.get(item.ingredientId) ?? null;
      // 缺数据 = 没有营养行；含估算 = 有行但 source 自证是估算（ADR-0013）——两者后果不同
      if (!per100g) missing.set(item.ingredientId, item.name);
      else if (isEstimatedNutritionSource(per100g.source)) estimated.set(item.ingredientId, item.name);
      return {
        ingredientId: item.ingredientId,
        name: item.name,
        grams: item.grams,
        per100g,
        // 缺数据 = null（**不是 0**）：既不进合计，界面也分得清「没算」与「算出来是 0」
        energyKcal: per100g ? round1((item.grams / 100) * per100g.energyKcal) : null,
        proteinG: per100g ? round1((item.grams / 100) * per100g.proteinG) : null,
        fatG: per100g ? round1((item.grams / 100) * per100g.fatG) : null,
        carbG: per100g ? round1((item.grams / 100) * per100g.carbG) : null,
      };
    });
    // 这一道里的两种「不是纯读数」：缺数据（没进合计）与含估算（进了合计）
    const dishMissing = ingredients.some((item) => item.per100g === null);
    const dishEstimated = ingredients.some(
      (item) => item.per100g !== null && isEstimatedNutritionSource(item.per100g.source),
    );
    return {
      recipeId: dish.recipeId,
      name: dish.name,
      kind: dish.kind,
      ingredients,
      // 合计是**逐食材取整后之和**：界面上把明细加起来要等于合计，不然一眼就露馅
      // （与份量的口径一致：菜的合计 = 取整后各项之和）
      energyKcal: sum(ingredients.map((item) => item.energyKcal)),
      proteinG: sum(ingredients.map((item) => item.proteinG)),
      fatG: sum(ingredients.map((item) => item.fatG)),
      carbG: sum(ingredients.map((item) => item.carbG)),
      // `partial` = 合计**不是全由成分表读数构成**（ADR-0013「决定二」把它的语义从
      // 「有食材没数据」扩到这里）：缺数据与含估算都算，两种情形靠 missing/estimated 分开说
      partial: dishMissing || dishEstimated,
      missing: dishMissing,
      estimated: dishEstimated,
    };
  });

  return {
    asOf: portion.asOf,
    factorSum: portion.factorSum,
    uplift: portion.uplift,
    diners: portion.diners,
    dishes,
    energyKcal: round1(sum(dishes.map((dish) => dish.energyKcal))),
    proteinG: round1(sum(dishes.map((dish) => dish.proteinG))),
    fatG: round1(sum(dishes.map((dish) => dish.fatG))),
    carbG: round1(sum(dishes.map((dish) => dish.carbG))),
    // 缺口按**第一次出现**的顺序给（＝菜与食材在菜单里的次序），家人扫一眼就知道是哪道菜
    missingIngredients: [...missing.entries()].map(([ingredientId, name]) => ({ ingredientId, name })),
    // 「含估算」单独一份清单：措辞是「这几项是估算的，数字是参考」，**不是**「没算进合计」
    estimatedIngredients: [...estimated.entries()].map(([ingredientId, name]) => ({ ingredientId, name })),
    // 合计不是全由读数构成（缺数据或含估算）——界面据此决定说不说「参考/偏低」那一句
    partial: missing.size > 0 || estimated.size > 0,
    // 注记按「本次读数里有没有估算项」分两种措辞：原句在含估算的读数上是假话（ADR-0013）
    nutritionSource: estimated.size > 0 ? NUTRITION_SOURCE_NOTE_ESTIMATED : NUTRITION_SOURCE_NOTE,
  };
}

/**
 * 整餐营养的口径注记（每份读数都带）。放在服务端而不是前端写死：
 * 它是**计算结果的一部分**（「这些数字是什么口径」），前端改文案不该改口径。
 *
 * **两种措辞**（ADR-0013「三条判据」的最后一条）：本次读数里**没有**估算项时用原句
 * （食材营养取《中国食物成分表》平均值）；**有**估算项时换成 `..._ESTIMATED`——
 * 那种情况下再说「食材营养取成分表平均值」就是假话（其中几项根本不是成分表读数）。
 */
const NUTRITION_SOURCE_NOTE =
  '每餐营养按本餐全部生重估算：食材营养取《中国食物成分表》每 100 g 可食部平均值，' +
  '份量含年龄折算与留量上浮，未计烹饪损耗（加热、沥油、汤汁残留）。数字为参考值，不是医学营养建议。';

/** 含估算项时的口径注记：说清**哪一部分**不是成分表读数（并把「参考」的分量说足） */
const NUTRITION_SOURCE_NOTE_ESTIMATED =
  '每餐营养按本餐全部生重估算：其中部分食材的营养是 AI 估算值（不是《中国食物成分表》读数，' +
  '出处见各食材的 source），其余取成分表每 100 g 可食部读数；份量含年龄折算与留量上浮，' +
  '未计烹饪损耗（加热、沥油、汤汁残留）。含估算项时数字只是参考，不是医学营养建议。';

/** 全部营养行（一次性取进内存：表只有一百多行，逐菜查库反而更绕） */
export function nutritionTable(db: Db): Map<string, IngredientNutrition> {
  const rows = db
    .prepare(
      'SELECT ingredient_id, energy_kcal, protein_g, fat_g, carb_g, source, note FROM ingredient_nutrition',
    )
    .all() as NutritionTableRow[];
  return new Map(rows.map((row) => [row.ingredient_id, ingredientNutritionRow(row)]));
}

/**
 * 单道菜的食谱（`GET /api/recipes/:id/recipe`）：做法步骤自由文本 + 食材清单。
 *
 * 为什么单独一个读接口而不是把 steps 塞进 `GET /recipes/:id`：那个接口已经在（#15），
 * 被菜谱管理与选菜器共用；本接口服务的是**做菜的人**（掌勺者站在灶台前看的那一屏），
 * 形状是「步骤 + 清单」而不是菜谱资源本身。配料清单直接复用 `RecipeIngredient`
 * （成人份基准，不随人数放大——食谱是「这道菜怎么做」的模板，不是某一餐的量）。
 *
 * `steps` 可能是空串（家庭菜里有的没写做法）：**照原样返回空串**，由界面决定怎么表达
 * 「这道还没写做法」。服务端不在这里编一句假步骤——空就是空。
 */
export function recipeDetail(db: Db, recipeId: string): RecipeDetail {
  const recipe = findRecipe(db, recipeId);
  if (!recipe) throw new RecipeNotFoundError(recipeId);
  return {
    recipeId: recipe.id,
    name: recipe.name,
    kind: recipe.kind,
    status: recipe.status,
    cuisine: recipe.cuisine,
    steps: recipe.steps,
    ingredients: recipe.ingredients,
  };
}

/** 一位小数的四舍五入（界面上不该出现 219.99999 这种数） */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 只把**有数据**的那些项加起来（缺数据是 null，不是 0） */
function sum(values: (number | null)[]): number {
  return round1(values.reduce<number>((total, value) => (value === null ? total : total + value), 0));
}
