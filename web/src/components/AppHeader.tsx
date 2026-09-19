import { IdentitySwitcher } from './IdentitySwitcher';
import { SettingsSheet } from './SettingsSheet';
import styles from './AppHeader.module.css';

/**
 * 头部的日期是「今天」的展示信息，直接用浏览器时间。
 *
 * 服务端的时钟 seam（clock.ts）管的是**业务判定**——「当前时刻之后」的餐槽、去重窗口、冷藏期到期、
 * 小孩年龄分带——那些必须能时间旅行测试。纯展示的日期不参与判定，所以不为此在 web 侧另建一条时钟 seam
 * （那会是为不存在的需求加抽象）。若日后该日期要与服务端的「今天」严格一致，再统一走服务端下发。
 */
function todayLabel(now: Date): string {
  const weekdays = '日一二三四五六';
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${weekdays[now.getDay()]}`;
}

/** 头部：标题 + 日期 + 常驻身份切换器（总纲 §2.4，无登录） */
export function AppHeader() {
  return (
    <header className={styles.header}>
      <div>
        <div className={styles.title}>家餐桌</div>
        <div className="sub">{todayLabel(new Date())}</div>
      </div>
      {/* 设置（⚙️，M1 只有「视图模式」一项）与身份条并列常驻：两者都是「这台手机的偏好」 */}
      <div className={styles.actions}>
        <SettingsSheet />
        <IdentitySwitcher />
      </div>
    </header>
  );
}
