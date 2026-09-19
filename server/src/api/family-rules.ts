import type { Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  CUTOFF_HOUR_RANGE,
  familyRules,
  InvalidCutoffHourError,
  InvalidUpliftError,
  LEFTOVER_UPLIFT_RANGE,
  updateFamilyRules,
} from '../domain/family-rules.js';
import { familyRulesAffectGrocery, markGroceryStaleForRules } from '../domain/grocery.js';

/**
 * 家规（总纲 §3：一份可调的单例配置，全部可调）。
 *
 * 读给界面显示那份配置（冷藏期天数 + 午/晚截止时刻 + 留量上浮系数），
 * 写给出一个可调的口。冷藏期的编辑入口归 #26 统一收口；上浮系数与**两个截止时刻**
 * （#23 评审修复 ①：它们会改变清单该含哪几餐，所以要有可写的口才能标过期，
 * 也才是总纲 §3 的「全部可调」）在本票开放。
 * 可配值由迁移 006 建表种下、007 补上留量上浮列。
 *
 * 路径刻意放在 `/family-rules` 而不是塞进 `/portion/rules`：家规与份量规则是两件事
 * （一份可调的自家配置 vs 一套带来源的国家标准数据），混在一个响应里会让后者看起来也能改。
 */
const patchSchema = z.object({
  /** 留量上浮系数：区间与迁移 007 的 CHECK 同源（领域层还会再拦一道，翻成人话） */
  leftoverUplift: z.number().min(LEFTOVER_UPLIFT_RANGE.min).max(LEFTOVER_UPLIFT_RANGE.max).optional(),
  /** 餐次截止时刻（家庭时区整点）；与迁移 006 的 CHECK 同源 */
  lunchCutoffHour: z
    .number()
    .int()
    .min(CUTOFF_HOUR_RANGE.min)
    .max(CUTOFF_HOUR_RANGE.max)
    .optional(),
  dinnerCutoffHour: z
    .number()
    .int()
    .min(CUTOFF_HOUR_RANGE.min)
    .max(CUTOFF_HOUR_RANGE.max)
    .optional(),
});

export function registerFamilyRulesRoutes(api: Hono, deps: AppDeps): void {
  api.get('/family-rules', (c) => c.json({ rules: familyRules(deps.db) }));

  api.patch('/family-rules', zodValidator('json', patchSchema), (c) => {
    const patch = c.req.valid('json');
    try {
      // 改家规前先照一张底：改动**会改变聚合结果**的家规值（留量上浮 / 两个截止时刻）时，
      // 进行中的买菜清单要标过期（#23 评审修复 ①）。不标的话，清单会**静默地**与新口径
      // 不一致：上浮改了 → 同一份菜单的克数变了；截止时刻改了 → 清单该含哪几餐变了。
      // 冷藏期那种与清单无关的值不进这个判定（`familyRulesAffectGrocery`）。
      const before = familyRules(deps.db);
      // 家规写入与「标清单过期」在**同一个事务**里（与 `PUT /slots/:id` 同口径）：
      // 两条写语句各自自动提交时，中间窗口会留下「家规已改、清单未过期」的静默不一致。
      const apply = deps.db.transaction(() => {
        const updated = updateFamilyRules(deps.db, deps.clock, patch);
        if (familyRulesAffectGrocery(before, updated)) markGroceryStaleForRules(deps.db);
        return updated;
      });
      const rules = apply();
      // 上浮系数被改后，份量规则接口里那份「配置值」也该跟着变；前端按 queryKey 失效
      return c.json({ rules });
    } catch (error) {
      if (error instanceof InvalidUpliftError) {
        return c.json({ error: 'invalid_uplift', value: error.value }, 400);
      }
      if (error instanceof InvalidCutoffHourError) {
        return c.json({ error: 'invalid_cutoff_hour', field: error.field, value: error.value }, 400);
      }
      throw error;
    }
  });
}
