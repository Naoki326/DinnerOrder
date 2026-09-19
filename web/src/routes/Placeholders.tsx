/** 占位页：页面不存在（买菜清单已由 `routes/GroceryView.tsx` 交付）。 */

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

/**
 * 买菜清单不再占位：`routes/GroceryView.tsx` 是 #23 的实现。
 * 旧占位已删——留着两份“买菜清单”会让人不知道哪份是真的。
 */
export function NotFoundView() {
  return <Placeholder title="页面不存在" note="检查一下地址？" />;
}
