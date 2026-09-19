/**
 * 前后端共享的线上类型（ADR-0002、总纲 §6：「共享类型由 server 导出」）。
 *
 * 这里是 web 包**唯一**允许导入的类型来源（`import type { … } from '@dinnerorder/server/types'`）——
 * 前端不再手抄一份同形状的接口。手抄的代价不是几行代码，而是两份定义悄悄漂移：后端把
 * `birthMonth` 改成 `bornMonth`、把 `avoid` 的条目从对象改成字符串，前端要到运行时才发现。
 *
 * 本文件**刻意自包含**（不 import 领域模块）：它只描述 HTTP 线上形状，不应把
 * better-sqlite3 / node:* 那套服务端类型经类型链条拖进前端类型检查。
 * 领域层反过来从本文件取材（见 domain/members.ts、domain/ingredients.ts），
 * 因此「线上形状」全仓只有这一处定义。
 */

/** 画像里的一个条目：指向食材字典的规范名 */
export interface ProfileEntry {
  ingredientId: string;
  /** 规范名——界面直接展示，前端不必再查一次字典 */
  name: string;
}

/** 家人画像（总纲 §2.9） */
export interface MemberProfile {
  id: string;
  name: string;
  emoji: string;
  /** 大人 / 小孩 */
  kind: 'adult' | 'child';
  gender: 'male' | 'female';
  /** 出生年月 'YYYY-MM'；小孩必有（#16 按它现算年龄分带折算份量），大人可空 */
  birthMonth: string | null;
  /** 掌勺者（餐后回顾的读者；M1 无权限判定，仅界面标注与默认当前身份） */
  isCook: boolean;
  /** 忌口：硬过滤，本餐任一用餐者命中即排除该菜 */
  avoid: ProfileEntry[];
  /** 爱吃：软加分，混合粒度（总纲 §2.9） */
  loves: ProfileEntry[];
}

/** 画像编辑的入参：三块各自独立——没传的块保持原样，传了的块整体替换 */
export interface ProfilePatch {
  /** 出生年月；`null` 表示清空（小孩拒收——#16 分带折算没有依据） */
  birthMonth?: string | null;
  /** 忌口清单（指向食材字典 id）；传了就整体替换——手机上的编辑是一次性提交完整清单 */
  avoid?: string[];
  /** 爱吃清单（指向食材字典 id） */
  loves?: string[];
}

/** 食材字典里的一条：规范名 + 别名（总纲 §3「食材字典」） */
export interface Ingredient {
  id: string;
  name: string;
  aliases: string[];
}

/** `/api/health` 的响应（#13 立的冒烟 API，web 首页页脚用它显示通道状态） */
export interface HealthResponse {
  ok: boolean;
  /** 注入时钟的当前值（测试拨动时钟后经 HTTP 可观测） */
  serverTime: string;
  basePath: string;
  llm: { tools: { name: string; description: string }[] };
}
