import { apiBaseUrl } from '../config';
import { useHealth } from '../api/health';
import styles from './HomeView.module.css';

/**
 * A 视图（默认）：下一餐大卡。
 *
 * 本票只落**空态**：骨架阶段还没有餐槽数据（餐槽模型是后续工单的交付），
 * 所以这里就是「最近未定餐槽」的占位，按钮禁用并标注「后续工单接通」。
 */
export function HomeView() {
  const health = useHealth();

  return (
    <div data-testid="home-view">
      <div className={`card ${styles.hero}`} data-testid="empty-slot">
        <div className={styles.kicker}>最近未定餐槽</div>
        <div className={styles.headline}>今晚吃什么？</div>
        <button type="button" className="btn block" disabled data-testid="recommend-button">
          ✨ 给我推荐
        </button>
        <div className={styles.actions}>
          <button type="button" className="btn ghost" disabled>
            🌙 吃中午剩的
          </button>
          <button type="button" className="btn ghost" disabled>
            🚫 不在这吃
          </button>
        </div>
        <div className="sub" style={{ marginTop: 10 }}>
          餐槽数据由后续工单接入；这张卡就是「下一餐优先」的位置。
        </div>
      </div>

      <div className={`card ${styles.ghostCard}`} data-testid="ghost-slot">
        <div className="spread">
          <span>
            <b>明天 · 晚餐</b> <span className="sub">未定</span>
          </span>
          <span className="badge">待接通</span>
        </div>
      </div>

      <div className={styles.footnote}>没定的餐 app 不打扰 —— 可能在外吃、吃剩的。</div>

      <footer className={`card sub`} data-testid="health-footer">
        <div className="spread">
          <span>API：{apiBaseUrl}</span>
          {health.isPending ? (
            <span className="badge">检查中…</span>
          ) : health.isError ? (
            <span className="badge warn">连接异常</span>
          ) : (
            <span className="badge ok" data-testid="health-ok">
              服务正常
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
