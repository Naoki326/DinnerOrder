import { AppHeader } from './components/AppHeader';
import { TabBar } from './components/TabBar';
import styles from './AppShell.module.css';

/** app 壳：头部 + 内容 + 底部主导航。三个视图模式（A/B/C）共用这一个壳。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell} data-testid="app-shell">
      <AppHeader />
      <main className={styles.content}>{children}</main>
      <TabBar />
    </div>
  );
}
