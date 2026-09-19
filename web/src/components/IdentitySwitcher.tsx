import { useState } from 'react';
import { Link } from 'react-router';
import { useIdentity } from '../identity';
import { memberSubtitle } from './memberLabel';
import styles from './IdentitySwitcher.module.css';

/**
 * 常驻身份切换器（总纲 §2.4）：点头像即切换**当前身份**，此后操作归属该身份。
 * 无登录、无口令；「这台设备当前是谁」存在本设备（见 web/src/identity.tsx 的取舍说明）。
 * 挂在 AppShell 层，因而每个界面都常驻。
 */
export function IdentitySwitcher() {
  const { members, current, switchIdentity } = useIdentity();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={styles.chip}
        data-testid="identity-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {current?.emoji ?? '👤'}
        </span>
        <span data-testid="identity-name">{current?.name ?? '…'}</span>
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div
          className={styles.mask}
          data-testid="identity-sheet"
          role="dialog"
          aria-label="切换当前身份"
          onClick={() => setOpen(false)}
        >
          {/* 点内容区不关面板：家人挑人时手指抖一下不该把面板关掉 */}
          <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
            <div className={styles.sheetHead}>
              <b>当前身份</b>
              <span className="sub">无登录 · 在这台手机上用谁的身份</span>
            </div>

            {members.map((member) => {
              const isCurrent = member.id === current?.id;
              return (
                <button
                  key={member.id}
                  type="button"
                  className={isCurrent ? `${styles.option} ${styles.on}` : styles.option}
                  data-testid={`identity-option-${member.id}`}
                  aria-pressed={isCurrent}
                  onClick={() => {
                    switchIdentity(member.id);
                    setOpen(false);
                  }}
                >
                  <span className={styles.avatar} aria-hidden="true">
                    {member.emoji}
                  </span>
                  <span className={styles.who}>
                    <span className={styles.name}>{member.name}</span>
                    {member.isCook ? <span className="badge acc"> 掌勺者</span> : null}
                    <div className="sub">{memberSubtitle(member)}</div>
                  </span>
                  {isCurrent ? (
                    <span className={styles.check} data-testid={`identity-current-${member.id}`}>
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}

            <div className={`sub ${styles.note}`}>
              换人只在这台手机生效，别人的手机不受影响。{' '}
              <Link to="/family" onClick={() => setOpen(false)}>
                改画像
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
