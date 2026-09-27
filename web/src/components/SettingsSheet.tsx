import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { VIEW_MODE_OPTIONS, useViewMode } from '../viewMode';
import styles from './SettingsSheet.module.css';

/**
 * 设置（⚙️）：M1 只有一项——**视图模式**（总纲 §2.10、spec §8 家人反馈①）。
 *
 * 与身份切换器同形的底部面板（同一个 `mask`/`sheet` 交互）：点遮罩收起、点内容区不收起，
 * 手机上少一层「弹层没关干净」的状态。
 *
 * 明确的纪律：原型底部的黑色胶囊变体切换条（`#proto-bar`）是**评审工具**，
 * 不得进产品（spec §8 末句）。产品里的三选一只在这个设置面板里出现。
 */
export function SettingsSheet() {
  const { mode, setMode } = useViewMode();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  /**
   * `/#settings` 开面板（issue #30）：菜谱库的「← 设置」返回指向它。
   *
   * 设置是一个弹层（不是路由），从属页面无法用 `navigate('/settings')` 回到它。
   * 用 hash 当「打开设置」的信号：回到首页 + 自动把面板摆开，人看到的就是「我回设置里了」。
   * 开过就把 hash 抹掉（用 `replace`，不往历史里再塞一条）——否则手动收起面板后一刷新又弹开。
   */
  useEffect(() => {
    if (location.hash === '#settings') {
      setOpen(true);
      navigate(`${location.pathname}${location.search}`, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  return (
    <>
      <button
        type="button"
        className={styles.gear}
        data-testid="settings-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="设置"
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⚙️</span>
      </button>

      {open ? (
        <div
          className={styles.mask}
          data-testid="settings-sheet"
          role="dialog"
          aria-label="设置"
          onClick={() => setOpen(false)}
        >
          <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
            <div className={styles.sheetHead}>
              <b>设置</b>
              <span className="sub">在这台手机上生效</span>
            </div>

            <div className="sub">视图模式（默认「下一餐大卡」，随时换，家人各用各的）</div>

            {VIEW_MODE_OPTIONS.map((option) => {
              const isCurrent = option.id === mode;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={isCurrent ? `${styles.option} ${styles.on}` : styles.option}
                  data-testid={`view-mode-option-${option.id}`}
                  aria-pressed={isCurrent}
                  onClick={() => {
                    setMode(option.id);
                    setOpen(false);
                  }}
                >
                  <span className={styles.who}>
                    <span className={styles.name}>{option.name}</span>
                    <div className="sub">{option.desc}</div>
                  </span>
                  <span className={isCurrent ? 'badge acc' : 'badge'}>{isCurrent ? '当前' : '选择'}</span>
                </button>
              );
            })}

            <div className={`sub ${styles.note}`}>
              三套视图的数据与操作完全一样（定餐/换菜/留量），只是摆法不同。切换只在这台手机生效。
            </div>

            {/*
              菜谱库（issue #30）：设置里的一个入口，进一个**独有页面** `/recipes`。
              不占用底部导航、不影响今天/买菜/回顾/家人这四页——它就是「你翻设置时能发现它」的那个位置。
              形态与上面「视图模式」三选项一致（同一个 `option` 样式）。
            */}
            <div className={`sub ${styles.section}`}>菜谱</div>
            <button
              type="button"
              className={styles.option}
              data-testid="settings-recipes-entry"
              onClick={() => {
                setOpen(false);
                navigate('/recipes');
              }}
            >
              <span className={styles.who}>
                <span className={styles.name}>菜谱库</span>
                <div className="sub">录入新菜、改做法、退役不做的菜</div>
              </span>
              <span className="badge">进入</span>
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
