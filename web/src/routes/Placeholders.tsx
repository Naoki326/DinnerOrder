/** 占位页：买菜清单 / 家人 是后续工单的交付。 */

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="card" data-testid="placeholder">
      <div className="spread">
        <b>{title}</b>
        <span className="badge">骨架占位</span>
      </div>
      <div className="sub" style={{ marginTop: 8 }}>
        {note}
      </div>
    </div>
  );
}

export function GroceryView() {
  return <Placeholder title="买菜清单" note="聚合行 / 手工行 / 过期重算由买菜清单工单接通。" />;
}

/**
 * 餐后回顾不再占位：`routes/ReviewView.tsx` 是本票（#20）的实现。
 * 旧占位已删——留着两份“回顾”会让人不知道哪份是真的。
 */
export function NotFoundView() {
  return <Placeholder title="页面不存在" note="检查一下地址？" />;
}
