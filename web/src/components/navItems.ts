/**
 * 四个日常页的入口清单——`TabBar`（手机版）与 `SideNav`（平板版）**同源**这一份。
 *
 * 抽出来而不是两处各写一遍：标签或路由悄悄漂移（加了「回顾」却只改了一处）在界面上看不出来，
 * 只有家人点错了才发现。两个形态共用一份数据，就只有一个真相。
 */
export interface NavItem {
  to: string;
  label: string;
  /** 首页要精确匹配（`/` 不然会一直亮着） */
  end: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: '🍽 今天', end: true },
  { to: '/grocery', label: '🛒 买菜', end: false },
  { to: '/review', label: '📝 回顾', end: false },
  { to: '/family', label: '👨‍👩‍👧‍👦 家人', end: false },
] as const;
