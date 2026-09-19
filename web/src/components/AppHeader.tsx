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

export function AppHeader({ identityName = '妈妈', identityEmoji = '👩' }: { identityName?: string; identityEmoji?: string }) {
  return (
    <header className={styles.header}>
      <div>
        <div className={styles.title}>家餐桌</div>
        <div className="sub">{todayLabel(new Date())}</div>
      </div>
      {/* 无登录、常驻身份切换器：切换与家人的真实数据由后续工单接通，这里只落位置 */}
      <button type="button" className={styles.identityChip} data-testid="identity-chip">
        <span aria-hidden="true">{identityEmoji}</span>
        <span>{identityName}</span>
        <span className="sub">▾</span>
      </button>
    </header>
  );
}
