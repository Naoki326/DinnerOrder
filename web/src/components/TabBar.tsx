import { NavLink } from 'react-router';
import styles from './TabBar.module.css';

const TABS = [
  { to: '/', label: '🍽 今天', end: true },
  { to: '/grocery', label: '🛒 买菜', end: false },
  { to: '/review', label: '📝 回顾', end: false },
  { to: '/family', label: '👨‍👩‍👧‍👦 家人', end: false },
];

/**
 * 底部主导航（原型 tabsA 的形态）＋一个常驻的「回顾」入口（总纲 §2.5：饭后餐卡的吃后感入口，
 * 不弹窗不推送——它是家人想去才去的一页，所以常驻在导航里而不是浮层）。
 * 三套视图共用它——视图模式只换主界面的摆法，不换导航。
 */
export function TabBar() {
  return (
    <nav className={styles.bar} aria-label="主导航" data-testid="tab-bar">
      <div className={styles.inner}>
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => (isActive ? `${styles.tab} ${styles.on}` : styles.tab)}
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
