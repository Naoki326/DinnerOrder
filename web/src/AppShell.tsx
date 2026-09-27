import { AppHeader } from './components/AppHeader';
import { SideNav } from './components/SideNav';
import { TabBar } from './components/TabBar';
import { useLayout } from './layout';
import styles from './AppShell.module.css';

/**
 * app 壳：头部（含常驻身份切换器）+ 内容 + 主导航。三套视图模式（A/B/C）共用这一个壳，
 * 两种版式（手机 / 平板）也共用它——版式只换导航形态与容器宽度。
 *
 * 根节点上的 `data-layout` 是**E2E 判定当前版式的唯一锚点**（页面内部不再各自判版式）。
 *
 * `hideNav`（原 `hideTabBar`，issue #30 起、#31 推广）：从属页面（如设置里的「菜谱库」）
 * 不要主导航——它是从设置钻进来的，不是四个日常页之一；摆着几条导航在那儿会让人以为可以
 * 直接跳走而丢掉正在编辑的表单。默认 false，四个现有页面与三视图的行为**完全不变**。
 * 两种版式下都藏（wide 藏 `SideNav`、narrow 藏 `TabBar`），story 18。
 */
export function AppShell({ children, hideNav = false }: { children: React.ReactNode; hideNav?: boolean }) {
  const { layout } = useLayout();
  const wide = layout === 'wide';

  return (
    <div
      className={[
        styles.shell,
        wide ? styles.wide : '',
        // 从属页面（菜谱库）没有侧边导航，内容列就不为它留位置（story 18）——
        // 否则会在左边空出一条与导航等宽的空白。
        wide && !hideNav ? styles.withNav : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="app-shell"
      data-layout={layout}
    >
      {wide && !hideNav ? <SideNav /> : null}
      <div className={styles.body}>
        <div className={styles.container}>
          <AppHeader />
          <main className={hideNav ? `${styles.content} ${styles.noTabs}` : styles.content}>{children}</main>
        </div>
      </div>
      {!wide && !hideNav ? <TabBar /> : null}
    </div>
  );
}
