import { useViewMode } from '../viewMode';
import { CompactView } from './CompactView';
import { HomeView } from './HomeView';
import { SimpleView } from './SimpleView';

/**
 * 主界面（`/`）的**窄版**视图模式分发：视图模式是**设备本地的呈现偏好**，只决定用哪个组件渲染
 * （总纲 §2.10：三套视图共享同一数据模型与操作语义）。
 *
 * 版式（手机/平板）的分发在**上一层** `LayoutRoute`——两个维度各一处，互不干涉：
 * 宽版下 A 是 `HomeWideView`，B/C 是它们自己（各自带宽屏 CSS）。
 */
export function HomeRoute() {
  const { mode } = useViewMode();
  if (mode === 'B') return <CompactView />;
  if (mode === 'C') return <SimpleView />;
  return <HomeView />;
}
