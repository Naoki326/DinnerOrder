import { useViewMode } from '../viewMode';
import { CompactView } from './CompactView';
import { HomeView } from './HomeView';
import { SimpleView } from './SimpleView';

/**
 * 主界面（`/`）的三视图分发：视图模式是**设备本地的呈现偏好**，只决定用哪个组件渲染
 * （总纲 §2.10：三套视图共享同一数据模型与操作语义）。
 *
 * 为什么单独一层而不把分发改进 `HomeView`：A 视图（下一餐大卡）是既有的、别票正在动的文件；
 * 分发器插在路由与三套视图之间，A 视图本体一行不改。
 */
export function HomeRoute() {
  const { mode } = useViewMode();
  if (mode === 'B') return <CompactView />;
  if (mode === 'C') return <SimpleView />;
  return <HomeView />;
}
