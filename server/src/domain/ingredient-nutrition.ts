import type { Db } from '../db/index.js';
import type { LlmClient } from '../llm/types.js';
import type { IngredientNutritionInput, NutritionEstimateResponse } from '../wire-types.js';import {
  estimateNutrition,
  estimatedNutritionSource,
  isEstimatedNutritionSource,
  type NutritionReference,
} from '../llm/nutrition-estimate-schema.js';

import type { IngredientNutrition } from '../wire-types.js';

// 线上形状定义在 wire-types.ts（前端也从那里取）
export type { IngredientNutritionInput, NutritionEstimateResponse } from '../wire-types.js';

/** `ingredient_nutrition` 的一行（列名就是表上的列名） */
export interface NutritionTableRow {
  ingredient_id: string;
  energy_kcal: number;
  protein_g: number;
  fat_g: number;
  carb_g: number;
  source: string;
  note: string | null;
}

/**
 * 一行营养读数 → 线上形状（**映射只有这一处**）。
 *
 * 两处读它：本模块的 `nutritionTable`（每餐营养合计）与 `domain/ingredients.ts` 的
 * `nutritionRefs`（字典条目带出的营养）。各写一份就会在「`estimated` 怎么算」这类细节上漂
 * ——而那个判定是本票的语义核心（ADR-0013「决定一」：靠 source 的固定前缀，不靠新列）。
 */
export function ingredientNutritionRow(row: NutritionTableRow): IngredientNutrition {
  return {
    ingredientId: row.ingredient_id,
    energyKcal: row.energy_kcal,
    proteinG: row.protein_g,
    fatG: row.fat_g,
    carbG: row.carb_g,
    source: row.source,
    estimated: isEstimatedNutritionSource(row.source),
    note: row.note,
  };
}


/**
 * 食材营养的**写入口**（CONTEXT「估算营养」；ADR-0013；issue #38）。
 *
 * 与只读那一侧（`domain/nutrition.ts` 的每餐合计）分开：那个模块回答「这一餐有多少营养」，
 * 这个模块回答「这条食材的四项营养从哪来、怎么落进 `ingredient_nutrition`」。
 *
 * 三条纪律（ADR-0013）：
 *   * **预填而非写入**：`suggestNutritionFor` 只读库、调一次 LLM，一个字节都不落；
 *   * **source 自证是估算**（决定一）：落库行的 source 由 `estimatedNutritionSource` 生成，
 *     带模型标识与参照的成分表条目——**同表同列**，靠 source 与读数区分，不加第二列；
 *   * **成分表读数不许被估算覆盖**（决定三）：已有非估算行时写入 → `NutritionLockedError`
 *     （明确报错，**不是静默忽略**）。估算行本身可以再被改（重估或人改）。
 */

/**
 * 这条食材已经有**成分表读数**，不许被估算改写（ADR-0013「决定三」）。
 *
 * 与「静默忽略」的区别是这条错误存在的全部意义：界面要能告诉掌勺者「这条是查来的读数，
 * 要改只能人来改」——静默忽略会让他以为保存成功了。
 */
export class NutritionLockedError extends Error {
  constructor(readonly ingredientId: string) {
    super(`这条食材已经有成分表读数，不能被估算改写：${ingredientId}`);
    this.name = 'NutritionLockedError';
  }
}

/**
 * 参照的条目不在「有成分表读数」的池子里（ADR-0013「决定一」）。
 *
 * 判据是**那条条目真的有非估算的读数**：指向一条没读数的字典条目（如蚝油）同样拒收——
 * 否则 `source` 里那句「参照《中国食物成分表》「X」的读数」就是假话。
 */
export class NutritionReferenceError extends Error {
  constructor(readonly reference: string) {
    super(`参照的条目没有成分表读数，不能当估算的参照：${reference}`);
    this.name = 'NutritionReferenceError';
  }
}

/** 一行营养读数的形状（`ingredient_nutrition`） */
interface NutritionRow {
  energy_kcal: number;
  protein_g: number;
  fat_g: number;
  carb_g: number;
  source: string;
}

/**
 * 可参照的成分表条目（估算的池子）：**已经有非估算读数**的条目，四项齐全。
 *
 * 两处口径（都是为了让 `source` 里的出处**回查得到**）：
 *   * **池子只含读数行，不含估算行**：估算要以权威读数为参照（ADR-0013 的整个前提是
 *     「参照最接近的成分表条目」）。拿一条估算去当另一条估算的参照会让出处链条变成
 *     「估算的估算」，越传越远而没人能回查。
 *   * **`name` 用成分表里的食物名，不是字典里的规范名**：012 的行把平台食物名写进了 source
 *     （「食物名「酱油(均值)」」），而字典那边叫「生抽」——ADR-0013 要求 source 写
 *     「参照 <最接近的成分表条目>」，所以这里取的是**成分表条目名**（取不到时回落到字典名，
 *     如水的定义性零点行）。
 */
export function nutritionReferences(db: Db): NutritionReference[] {
  const rows = db
    .prepare(
      `SELECT n.ingredient_id, i.name, n.energy_kcal, n.protein_g, n.fat_g, n.carb_g, n.source
         FROM ingredient_nutrition n JOIN ingredients i ON i.id = n.ingredient_id
        ORDER BY i.name`,
    )
    .all() as {
    ingredient_id: string;
    name: string;
    energy_kcal: number;
    protein_g: number;
    fat_g: number;
    carb_g: number;
    source: string;
  }[];

  return rows
    .filter((row) => !isEstimatedNutritionSource(row.source))
    .map((row) => ({
      ingredientId: row.ingredient_id,
      name: componentTableName(row.source) ?? row.name,
      energyKcal: row.energy_kcal,
      proteinG: row.protein_g,
      fatG: row.fat_g,
      carbG: row.carb_g,
    }));
}

/**
 * 从既有行的 source 里取出成分表的食物名（012 的逐行出处写的就是「食物名「X」」）。
 *
 * 取不到就回落到字典规范名（水的定义性零点行没有食物名——它不是成分表读数）。
 * 用正则而不是新加一列：012 已经把食物名写进 source 了，为它加一列等于给同一件事两个真相。
 */
function componentTableName(source: string): string | undefined {
  return /食物名「([^」]+)」/.exec(source)?.[1];
}

/**
 * 估算营养（离线路径，人点一下才跑一次）：给一条**还没有读数**的食材预填四项。
 *
 * 与「含」提议同一形态（只读 + 调一次 LLM、产出是预填），三处刻意的差别：
 *   * **池子带数字**：模型要挑最接近的读数、再在它基础上调整（只给名字等于让它凭空猜）；
 *   * **降级不是失败**：LLM 用不了就返回 `degraded: true`（路由照 200），
 *     手填这条路永远不受影响；
 *   * **产出必须能回查**：参照条目由 `resolveNutritionEstimate` 钉在池内，越界即整条不可用。
 *
 * `name` 已经在字典里（录入之后补营养）时也照常工作：估算只看名字与池子，不看它有没有 id。
 */
export async function suggestNutritionFor(
  db: Db,
  llm: LlmClient,
  name: string,
): Promise<NutritionEstimateResponse> {
  const outcome = await estimateNutrition(llm, { name: name.trim(), references: nutritionReferences(db) });
  if (!outcome.estimate) return { degraded: outcome.degraded };
  return {
    estimate: {
      energyKcal: outcome.estimate.energyKcal,
      proteinG: outcome.estimate.proteinG,
      fatG: outcome.estimate.fatG,
      carbG: outcome.estimate.carbG,
      reference: outcome.estimate.reference,
    },
    degraded: false,
    model: outcome.model ?? llm.model,
  };
}

/**
 * 把**人确认过**的四项营养写进 `ingredient_nutrition`（录入与改食材两条路共用）。
 *
 * 校验顺序与其余写路径同一纪律：**先把该拒的全拒掉，再写**——一次写入里出任何错都不留半截行。
 * 调用方负责把这句放在自己的事务里（`createIngredient` / `patchIngredient` 都这么做）。
 *
 * `allowEstimatedOverwriteOfNothing` 这一层不做：判据只有「既有行是不是读数」。
 */
export function writeIngredientNutrition(
  db: Db,
  ingredientId: string,
  input: IngredientNutritionInput,
  fallbackModel: string,
): void {
  const reference = db
    .prepare(
      `SELECT n.ingredient_id, i.name, n.source FROM ingredient_nutrition n
         JOIN ingredients i ON i.id = n.ingredient_id WHERE n.ingredient_id = ?`,
    )
    .get(input.reference) as { ingredient_id: string; name: string; source: string } | undefined;
  // 参照必须**真有成分表读数**（估算行不算：出处链条不能是「估算的估算」）
  if (!reference || isEstimatedNutritionSource(reference.source)) {
    throw new NutritionReferenceError(input.reference);
  }

  const existing = nutritionRow(db, ingredientId);
  // 已有读数 → 拒收（ADR-0013「决定三」）。估算行与「还没有行」都可以写。
  if (existing && !isEstimatedNutritionSource(existing.source)) {
    throw new NutritionLockedError(ingredientId);
  }

  // 参照名用**成分表的食物名**（与 `nutritionReferences` 同一个取值口径：出处要能回查）
  const referenceName = componentTableName(reference.source) ?? reference.name;
  // 模型标识优先用**产出这份估算的那个**（客户端回传），没回传才回落到服务端配置的名字
  const model = input.model?.trim() ? input.model.trim() : fallbackModel;
  const source = estimatedNutritionSource(model, { ingredientId: reference.ingredient_id, name: referenceName });
  db.prepare(
    `INSERT INTO ingredient_nutrition (ingredient_id, energy_kcal, protein_g, fat_g, carb_g, source, note)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(ingredient_id) DO UPDATE SET
       energy_kcal = excluded.energy_kcal,
       protein_g = excluded.protein_g,
       fat_g = excluded.fat_g,
       carb_g = excluded.carb_g,
       source = excluded.source,
       note = NULL`,
  ).run(ingredientId, input.energyKcal, input.proteinG, input.fatG, input.carbG, source);
}

/** 这条食材现有的营养行（没有则 undefined） */
export function nutritionRow(db: Db, ingredientId: string): NutritionRow | undefined {
  return db
    .prepare('SELECT energy_kcal, protein_g, fat_g, carb_g, source FROM ingredient_nutrition WHERE ingredient_id = ?')
    .get(ingredientId) as NutritionRow | undefined;
}

/**
 * 提交的四项是不是**真的与库里那一行不同**（「改食材」用它决定算不算一次改动）。
 *
 * 只比四项数字，**不比参照条目与模型名**：重估时参照可能换成另一条读数（甚至同一个数字来自另一条
 * 成分表条目），但那不改变这一条食材的营养读数——把参照也算成改动会让「点开看了看又保存」
 * 写出一笔「改了营养」的假台账（迁移 016 的 `changed_fields <> ''` 正是拦空行的）。
 *
 * 库里**还没有行**时：提交了四项就算一次改动（从「暂缺」变成「有估算」是真实的变化）。
 */
export function nutritionChanged(db: Db, ingredientId: string, input: IngredientNutritionInput): boolean {
  const existing = nutritionRow(db, ingredientId);
  if (!existing) return true;
  return (
    existing.energy_kcal !== input.energyKcal ||
    existing.protein_g !== input.proteinG ||
    existing.fat_g !== input.fatG ||
    existing.carb_g !== input.carbG
  );
}
