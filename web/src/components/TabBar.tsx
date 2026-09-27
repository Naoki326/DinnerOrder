import { NavLink } from 'react-router';
import { NAV_ITEMS } from './navItems';
import styles from './TabBar.module.css';

/**
 * 底部主导航（原型 tabsA 的形态）＋一个常驻的「回顾」入口（总纲 §2.5：饭后餐卡的吃后感入口，
 * 不弹窗不推送——它是家人想去才去的一页，所以常驻在导航里而不是浮层）。
 * 三套视图共用它——视图模式只换主界面的摆法，不换导航。
 *
 * 手机版（`layout === 'narrow'`）的形态，平板版是 `SideNav`——两者共用 `NAV_ITEMS` 这份入口清单。
 * `data-testid` 有两层：`main-nav` 是「四个日常页入口」的**稳定语义名**（两个形态都挂，
 * 与版式无关的操作一律走它），`tab-bar` 是这个形态自己的名字（供「此刻是哪种导航形态」的断言）。
 */
export function TabBar() {
  return (
    <nav className={styles.bar} aria-label="主导航" data-testid="tab-bar">
      <div className={styles.inner}>
        {NAV_ITEMS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            data-testid="main-nav"
            className={({ isActive }) => (isActive ? `${styles.tab} ${styles.on}` : styles.tab)}
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
