import { useLayout } from '../layout';
import { ReviewView } from './ReviewView';
import { ReviewWideView } from './ReviewWideView';

/**
 * 餐后回顾的第一层分发：**按版式**（手机单列 / 平板双列）。与首页的 `LayoutRoute` 同一形状：
 * 版式是一层、内容本体不动。
 */
export function ReviewRoute() {
  const { layout } = useLayout();
  if (layout === 'wide') return <ReviewWideView />;
  return <ReviewView />;
}
