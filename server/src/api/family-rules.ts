import type { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { familyRules } from '../domain/family-rules.js';

/**
 * 家规（总纲 §3：一份可调的单例配置）。
 *
 * 本票只**读**：可配值（冷藏期天数、餐次截止时刻）由迁移 006 种下，界面与管线都读这一处。
 * 写入（掌勺者在界面上改家规）不在本票的 AC 里——本票要的是「冷藏期家规可配」，
 * 可配的机制是「值进表 + 运行时读表」，改值走家规编辑入口（#26 统一收口时会与其余家规值一起做）。
 *
 * 路径刻意放在 `/family-rules` 而不是塞进 `/portion/rules`：家规与份量规则是两件事
 * （一份可调的自家配置 vs 一套带来源的国家标准数据），混在一个响应里会让后者看起来也能改。
 */
export function registerFamilyRulesRoutes(api: Hono, deps: AppDeps): void {
  api.get('/family-rules', (c) => c.json({ rules: familyRules(deps.db) }));
}
