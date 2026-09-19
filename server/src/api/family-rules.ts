import type { Hono } from 'hono';
import { z } from 'zod';
import { zodValidator } from './validation.js';
import type { AppDeps } from '../app.js';
import {
  familyRules,
  InvalidUpliftError,
  LEFTOVER_UPLIFT_RANGE,
  updateFamilyRules,
} from '../domain/family-rules.js';

/**
 * 家规（总纲 §3：一份可调的单例配置，全部可调）。
 *
 * 读给界面显示那份配置（冷藏期天数 + 午/晚截止时刻 + 留量上浮系数），
 * 写给出一个可调的口（本票只开放留量上浮系数——冷藏期与截止时刻的编辑入口归 #26 统一收口）。
 * 可配值由迁移 006 建表种下、007 补上留量上浮列。
 *
 * 路径刻意放在 `/family-rules` 而不是塞进 `/portion/rules`：家规与份量规则是两件事
 * （一份可调的自家配置 vs 一套带来源的国家标准数据），混在一个响应里会让后者看起来也能改。
 */
const patchSchema = z.object({
  /** 留量上浮系数：区间与迁移 007 的 CHECK 同源（领域层还会再拦一道，翻成人话） */
  leftoverUplift: z.number().min(LEFTOVER_UPLIFT_RANGE.min).max(LEFTOVER_UPLIFT_RANGE.max).optional(),
});

export function registerFamilyRulesRoutes(api: Hono, deps: AppDeps): void {
  api.get('/family-rules', (c) => c.json({ rules: familyRules(deps.db) }));

  api.patch('/family-rules', zodValidator('json', patchSchema), (c) => {
    const patch = c.req.valid('json');
    try {
      const rules = updateFamilyRules(deps.db, deps.clock, patch);
      // 上浮系数被改后，份量规则接口里那份「配置值」也该跟着变；前端按 queryKey 失效
      return c.json({ rules });
    } catch (error) {
      if (error instanceof InvalidUpliftError) {
        return c.json({ error: 'invalid_uplift', value: error.value }, 400);
      }
      throw error;
    }
  });
}
