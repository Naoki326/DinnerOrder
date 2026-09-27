import { useLayout } from '../layout';
import { useViewMode } from '../viewMode';
import { CompactView } from './CompactView';
import { HomeRoute } from './HomeRoute';
import { HomeWideView } from './HomeWideView';
import { SimpleView } from './SimpleView';

/**
 * 首页的第一层分发：**版式 × 视图模式**两个维度的映射（总纲 §2.10，两者正交）。
 *
 *   窄版（手机）：原样交给 `HomeRoute`（A/B/C 三套今天的单列摆法，一行不改）；
 *   宽版（平板）：A 用新的 `HomeWideView`（左列时间轴 + 右列详情），B/C 仍是它们自己
 *   （story 49：三套视图在平板上**都能用**，不是只有 A 能用）——它们各自的宽屏摆法在自己
 *   的 CSS 里（B 按天分列、C 限宽 + 菜卡网格），所以是同一套组件、不同宽度。
 *
 * 为什么单独一层而不往三套视图里塞 `if (wide)`：三套既有视图本体一行不改（窄摆法完全不变），
 * 宽屏摆法要么是新组件（A），要么是同组件 + 自己的宽屏 CSS（B/C）。
 */
export function LayoutRoute() {
  const { layout } = useLayout();
  const { mode } = useViewMode();

  if (layout === 'wide') {
    if (mode === 'B') return <CompactView />;
    if (mode === 'C') return <SimpleView />;
    return <HomeWideView />;
  }
  return <HomeRoute />;
}
