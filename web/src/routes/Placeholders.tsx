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

export function FamilyView() {
  return <Placeholder title="家人" note="画像（忌口、爱吃）与家人管理由画像工单接通。" />;
}

export function ReviewView() {
  return <Placeholder title="餐后回顾" note="点踩 / 点赞 + 快捷标签由反馈工单接通。" />;
}

export function NotFoundView() {
  return <Placeholder title="页面不存在" note="检查一下地址？" />;
}
