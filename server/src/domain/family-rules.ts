import type { Db } from '../db/index.js';
import type { FamilyRules } from '../wire-types.js';

/**
 * 家规（总纲 §3：**一份可调的单例配置**）的读取口。
 *
 * 为什么单开一个文件而不是塞进 `feedback.ts`：家规是**全领域共用的配置**，
 * 反馈只是它的第一个读者（冷藏期）。#22 的留量上浮系数、#26 的统一收口都会往这里加，
 * 让「家规读在哪」始终只有一处。表里的列由迁移 006 建、单例行由它种下。
 *
 * 本票只放自己需要的可调值（冷藏天数 + 餐次截止时刻），**不搬**推荐管线的其余常量
 * （基线荤素、去重窗口、LLM 超时…）：那是 #26 的统一收口，见 `domain/recommendation.ts`
 * 里那几处 TODO。表与读取口先立起来，那些值日后往这里加列即可。
 *
 * 读不到就报错而不是兜底默认值：家规是单例、又由迁移种下，读不到只可能是库坏了——
 * 悄悄回退到「14 天」会让一个坏库看起来一切正常。
 */
export function familyRules(db: Db): FamilyRules {
  const row = db
    .prepare('SELECT cool_off_days, lunch_cutoff_hour, dinner_cutoff_hour FROM family_rules WHERE id = 1')
    .get() as { cool_off_days: number; lunch_cutoff_hour: number; dinner_cutoff_hour: number } | undefined;
  if (!row) throw new FamilyRulesMissingError();
  return {
    coolOffDays: row.cool_off_days,
    lunchCutoffHour: row.lunch_cutoff_hour,
    dinnerCutoffHour: row.dinner_cutoff_hour,
  };
}

/** 家规单例行不在库里（迁移 006 没跑成功 / 被手删了）——这是库坏了，不兜底 */
export class FamilyRulesMissingError extends Error {
  constructor() {
    super('family_rules 缺了单例行（迁移 006 应种下一行）：家规读不出来');
    this.name = 'FamilyRulesMissingError';
  }
}

/** 冷藏期天数（家规）：域内多处要用，单独一个读取口免得每处都查一遍整表 */
export function coolOffDays(db: Db): number {
  return familyRules(db).coolOffDays;
}
