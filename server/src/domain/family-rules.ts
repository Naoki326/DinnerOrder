import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type { FamilyRules, FamilyRulesPatch } from '../wire-types.js';

/**
 * 家规（总纲 §3：**一份可调的单例配置，全部可调**）的读取口与写入口。
 *
 * 为什么单开一个文件而不是塞进某个读者里：家规是**全领域共用的配置**，反馈（冷藏期）只是
 * 它的第一个读者，留量上浮、餐次截止时刻、#26 的统一收口都从这一处进出，让「家规读/写在哪」
 * 始终只有一处。表由迁移 006 建、单例行由它种下，007 再给同一张表加本仓的留量上浮列。
 *
 * 本仓现存四个值：**冷藏期天数**（006）、**午/晚餐次截止时刻**（006）与**留量上浮系数**（007，
 * 总纲 §2.6 默认 1.5×，家规可配）。推荐管线的其余常量（基线荤素、去重窗口、LLM 超时…）
 * 留给 #26 统一收口——见 `domain/recommendation.ts` 里那几处 TODO，搬进 `family_rules`
 * 同一张单例表、列求并集即可。
 *
 * 读不到就报错而不是兜底默认值：家规是单例、又由迁移种下，读不到只可能是库坏了——
 * 悄悄回退到「14 天 / 1.5×」会让一个坏库看起来一切正常（与「家规读在哪」只有一处的意图一起：
 * 谁读家规都从这一个口进，改表时不会漏掉某处）。
 */
export function familyRules(db: Db): FamilyRules {
  const row = db
    .prepare(
      'SELECT cool_off_days, lunch_cutoff_hour, dinner_cutoff_hour, leftover_uplift FROM family_rules WHERE id = 1',
    )
    .get() as
    | {
        cool_off_days: number;
        lunch_cutoff_hour: number;
        dinner_cutoff_hour: number;
        leftover_uplift: number;
      }
    | undefined;
  if (!row) throw new FamilyRulesMissingError();
  return {
    coolOffDays: row.cool_off_days,
    lunchCutoffHour: row.lunch_cutoff_hour,
    dinnerCutoffHour: row.dinner_cutoff_hour,
    leftoverUplift: row.leftover_uplift,
  };
}

/** 家规单例行不在库里（迁移 006 没跑成功 / 被手删了）——这是库坏了，不兜底 */
export class FamilyRulesMissingError extends Error {
  constructor() {
    super('family_rules 缺了单例行（迁移 006 应建表种行、007 应补上留量上浮列）：家规读不出来');
    this.name = 'FamilyRulesMissingError';
  }
}

/** 冷藏期天数（家规）：域内多处要用，单独一个读取口免得每处都查一遍整表 */
export function coolOffDays(db: Db): number {
  return familyRules(db).coolOffDays;
}

/** 留量上浮系数的可接受区间（与迁移 007 的 CHECK 同源） */
export const LEFTOVER_UPLIFT_RANGE = { min: 1, max: 5 } as const;

/** 掌勺者提交的上浮系数超出可接受区间 */
export class InvalidUpliftError extends Error {
  constructor(readonly value: number) {
    super(`留量上浮系数必须在 ${LEFTOVER_UPLIFT_RANGE.min}–${LEFTOVER_UPLIFT_RANGE.max} 之间：${value}`);
    this.name = 'InvalidUpliftError';
  }
}

/**
 * 改家规（单例配置的常规写入口，总纲 §3「全部可调」）。
 *
 * 没传的项保持原样（部分更新）：家规是一份配置，不是每次都要提交全部字段的表单。
 * 区间在领域层也拦一道（不只靠 CHECK）：`InvalidUpliftError` 能翻成一句人话，
 * 而 SQLite 的 CHECK 失败是一句没法解释给家人听的英文。
 *
 * `updated_at` 走注入时钟（与事件留痕同一套时间基准）：测试里拨钟也能看见配置的改动时刻。
 */
export function updateFamilyRules(db: Db, clock: Clock, patch: FamilyRulesPatch): FamilyRules {
  const current = familyRules(db);
  const next = patch.leftoverUplift ?? current.leftoverUplift;
  if (next < LEFTOVER_UPLIFT_RANGE.min || next > LEFTOVER_UPLIFT_RANGE.max) throw new InvalidUpliftError(next);
  db.prepare('UPDATE family_rules SET leftover_uplift = ?, updated_at = ? WHERE id = 1').run(
    next,
    clock.now().toISOString(),
  );
  return familyRules(db);
}
