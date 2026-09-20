import type { ReactNode } from 'react';
import styles from './Sheet.module.css';

/**
 * 底部面板（弹层）的共用壳：与 `SettingsSheet` 同一个 `mask`/`sheet` 交互
 * （点遮罩收起、点内容区不收起、`role="dialog"` + `aria-label`）。
 *
 * 为什么要抽这一层：本票一次加了两个弹层（整餐营养、单道菜食谱），加上已有的设置面板
 * 就是三处同样的交互。抄三遍会在「点内容区不收起」这类细节上漂移——把它收成一处，
 * 交互只有一份实现，面板各自只关心内容。
 *
 * **不做**的事项（有意）：不锁 body 滚动、不做 Esc 关闭、不做焦点陷阱——本仓既有的
 * 设置面板也没有这三样，手机场景下点遮罩是主要退出方式；单独给新面板加上会让三处行为不一致。
 */
export function Sheet({
  label,
  testId,
  onClose,
  children,
  header,
}: {
  /** 无障碍名称（`role="dialog"` 的 `aria-label`），中文照 `CONTEXT.md` 词汇 */
  label: string;
  /** E2E 定位用（不带 `-sheet` 后缀，调用方自己起名） */
  testId: string;
  onClose: () => void;
  /** 面板头部（标题 + 可选的关闭按钮），由调用方拼——不同面板的标题行不一样 */
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.mask} data-testid={testId} role="dialog" aria-label={label} onClick={onClose}>
      {/* 点内容区不收起：`stopPropagation` 挡住遮罩的 onClick（与设置面板同形） */}
      <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
        <div className={styles.head}>
          {header}
          <button type="button" className={styles.close} data-testid={`${testId}-close`} onClick={onClose}>
            收起
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
