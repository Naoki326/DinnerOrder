import { AppHeader } from './components/AppHeader';
import { TabBar } from './components/TabBar';
import styles from './AppShell.module.css';

/**
 * app 壳：头部（含常驻身份切换器）+ 内容 + 底部主导航。三个视图模式（A/B/C）共用这一个壳。
 *
 * `hideTabBar`（issue #30，纯加性）：从属页面（如设置里的「菜谱库」）不要底部主导航——
 * 它是从设置钻进来的，不是四个日常页之一；摆着四条导航在那儿会让人以为可以直接跳走而丢掉
 * 正在编辑的表单。默认 false，四个现有页面与三视图的行为**完全不变**。
 */
export function AppShell({ children, hideTabBar = false }: { children: React.ReactNode; hideTabBar?: boolean }) {
  return (
    <div className={styles.shell} data-testid="app-shell">
      <AppHeader />
      <main className={hideTabBar ? `${styles.content} ${styles.noTabs}` : styles.content}>{children}</main>
      {hideTabBar ? null : <TabBar />}
    </div>
  );
}
