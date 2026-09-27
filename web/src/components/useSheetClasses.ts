import { useLayout } from '../layout';
import styles from './sheetShared.module.css';

/**
 * 弹层的遮罩/面板类名（手机版底部抽屉 / 平板版居中对话框），由**版式偏好**决定。
 *
 * 三个面板（`Sheet` / `SettingsSheet` / `IdentitySwitcher`）共用这一份：本来它们各有一份
 * 长得几乎一样的遮罩 CSS，抄三遍必在「点内容区不收起」这类细节上漂移（#31 顺手收口，
 * 不动任何面板的组件结构）。
 *
 * 组件按 `useLayout()` 选形态而不是纯 CSS 媒体查询：设置里的手动覆盖必须同时作用于弹层
 * （否则会出现「平板版页面 + 手机版抽屉」的错配）。
 */
export function useSheetClasses(): { mask: string; sheet: string } {
  const { layout } = useLayout();
  return layout === 'wide'
    ? { mask: `${styles.mask} ${styles.maskWide}`, sheet: `${styles.sheet} ${styles.sheetWide}` }
    : { mask: `${styles.mask} ${styles.maskNarrow}`, sheet: `${styles.sheet} ${styles.sheetNarrow}` };
}
