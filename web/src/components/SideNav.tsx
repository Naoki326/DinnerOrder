import { NavLink } from 'react-router';
import { NAV_ITEMS } from './navItems';
import styles from './SideNav.module.css';

/**
 * 左侧竖排主导航（平板版）：与底部 `TabBar` **同一份入口**（`NAV_ITEMS`），只是换个摆法。
 *
 * 平板上的动线问题：底部固定的胶囊导航在 10 寸屏上离视线很远，按「买菜」「回顾」要伸手够屏幕
 * 底边。竖排在左手边，四个日常页常驻可见、一指可达。语义与手机版逐条相同（点「买菜」去
 * `/grocery`，点「今天」回 `/`），当前页有选中态。
 *
 * 无障碍：`<nav aria-label="主导航">`（与 `TabBar` 同名——两处是同一个主导航的两种形态），
 * 当前页由 `NavLink` 落 `aria-current="page"`。
 *
 * `z-index` 刻意**低于弹层的 60**（见 `Sheet.module.css` 的遮罩）：弹层打开时导航点不动，
 * 不会出现「以为点到了导航其实点到了遮罩」（故事 45）。
 */
export function SideNav() {
  return (
    <nav className={styles.nav} aria-label="主导航" data-testid="side-nav">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          data-testid="main-nav"
          className={({ isActive }) => (isActive ? `${styles.item} ${styles.on}` : styles.item)}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
