import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * 「这台设备的界面偏好」——**设备本地的偏好**，不是服务端数据。
 *
 * 与「当前身份」（`identity.tsx`）同级（总纲 §2.10 把两者并列）：共用 iPad 上换成「长辈小孩极简」，
 * 不影响掌勺者手机上的「下一餐大卡」。所以它存在 localStorage，服务端不为它建表——
 * 服务端那张表迟早要处理「多设备同时偏好不同」这种它根本管不了的冲突。
 *
 * 三套视图共享同一数据模型与操作语义（换菜/留量/回顾行为一致），只有呈现不同：
 * 视图模式**只决定用哪个组件渲染主界面**，不进任何接口入参、不进留痕。
 */
const STORAGE_KEY = 'dinnerorder.viewMode';

export type ViewMode = 'A' | 'B' | 'C';

/** 视图模式的三选一：名字与说明直接搬原型设置面板的文案（原型 8ff84db 的家人反馈①：三套都保留、默认 A） */
export interface ViewModeOption {
  id: ViewMode;
  name: string;
  desc: string;
}

export const VIEW_MODE_OPTIONS: readonly ViewModeOption[] = [
  { id: 'A', name: '下一餐大卡', desc: '首页只关心「下一顿吃什么」，换菜走候选面板 —— 默认' },
  { id: 'B', name: '掌勺者紧凑流', desc: '按天看全部餐槽与菜单，信息密度高 —— 掌勺者视角' },
  { id: 'C', name: '长辈小孩极简', desc: '一屏一件事、大按钮、两步向导 —— 长辈小孩友好' },
] as const;

export const DEFAULT_VIEW_MODE: ViewMode = 'A';

function isViewMode(value: string | null): value is ViewMode {
  return value === 'A' || value === 'B' || value === 'C';
}

function readStoredMode(): ViewMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // 认不出的值（手改过、旧版本写的）退回默认，而不是白屏
    return isViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
  } catch {
    // 隐私模式等场景下 localStorage 可能不可用：降级成「本次会话内有效」
    return DEFAULT_VIEW_MODE;
  }
}

function writeStoredMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 同上：存不下就只当次生效，界面不因此报错
  }
}

export interface ViewModeContextValue {
  /** 当前视图模式（默认 A 下一餐大卡） */
  mode: ViewMode;
  /** 切换视图模式：写本设备存储、立即对所有界面生效 */
  setMode(mode: ViewMode): void;
}

const ViewModeContext = createContext<ViewModeContextValue | undefined>(undefined);

export function ViewModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ViewMode>(() => readStoredMode());

  const setMode = useCallback((next: ViewMode) => {
    setModeState(next);
    writeStoredMode(next);
  }, []);

  const value = useMemo<ViewModeContextValue>(() => ({ mode, setMode }), [mode, setMode]);

  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
}

export function useViewMode(): ViewModeContextValue {
  const value = useContext(ViewModeContext);
  if (!value) throw new Error('useViewMode 必须在 ViewModeProvider 内使用');
  return value;
}
