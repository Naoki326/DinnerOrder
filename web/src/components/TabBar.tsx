import { NavLink } from 'react-router';
import styles from './TabBar.module.css';

const TABS = [
  { to: '/', label: '🍽 今天', end: true },
  { to: '/grocery', label: '🛒 买菜', end: false },
  { to: '/family', label: '👨‍👩‍👧‍👦 家人', end: false },
];

/** 底部主导航（原型 tabsA 的形态）。三视图是设备本地偏好，留给设置票。 */
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
