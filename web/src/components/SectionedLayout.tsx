import { Children, isValidElement, type ReactNode } from 'react';
import { useLayout } from '../layout';
import styles from './SectionedLayout.module.css';

/**
 * 「同一串卡片，两种摆法」的壳（#31）：把子节点按 `data-section="dishes"` 分成两列，
 * 或者（窄版）原样单列返回。
 *
 * 为什么值得抽：定餐编辑器（左挑菜 / 右份量·用餐者）与回顾页（左餐次 / 右反馈）都是
 * 「一张张卡片换个摆法」，而卡片本身一行不改是最重要的纪律——宽屏摆法是**新的分组**，
 * 不是往既有卡片里塞 `if (wide)`。用属性做分组标记，卡片组件不必知道版式的存在。
 *
 * `data-section` 对窄版渲染没有任何影响（它只是一个属性），所以同一份 JSX 两版共用。
 *
 * ⚠️ 宽窄由**版式偏好**决定（`useLayout()`），不是由窗口宽度猜的——手动选「手机版」时
 * 即使窗口很宽也要保持单列。
 */
export function SectionedLayout({
  sideSection,
  testId,
  extra,
  children,
}: {
  /** 哪一组进右边那一列（左边那一列是其余全部）——写错一个字母会把卡片悄悄挪到左列，
   *  所以取值收成 `SectionName`（页面里的 `data-section` 必须与它一致） */
  sideSection: SectionName;
  /** 窄版根节点的 `data-testid`（宽版根节点另挂 `data-layout-view="wide"`） */
  testId: string;
  /** 要挂在根节点上的其它属性（如 `data-slot-id`） */
  extra?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  const { layout } = useLayout();
  const kids = Children.toArray(children);
  const rootProps = { 'data-testid': testId, ...extra };

  // 窄版：一串卡片原样返回（根节点上不写 `data-layout-view`——窄版不是「宽屏摆法」）
  if (layout !== 'wide') return <div {...rootProps}>{kids}</div>;

  const isSide = (child: ReactNode): boolean =>
    isValidElement(child) && (child.props as { 'data-section'?: string })['data-section'] === sideSection;
  const side = kids.filter(isSide);
  const main = kids.filter((child) => !isSide(child));

  return (
    <div {...rootProps} data-layout-view="wide">
      <div className={styles.columns}>
        {/* 两列各自是一串竖排卡片：相对顺序与单列时完全一致，只是分了两栏 */}
        <div className={styles.column}>{main}</div>
        <div className={styles.column}>{side}</div>
      </div>
    </div>
  );
}

/** `data-section` 的取值：进右列的那一组 */
export type SectionName = 'dishes' | 'diners' | 'detail';
