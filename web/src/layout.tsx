import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * 「这台设备用哪种版式」——**设备本地的偏好**，与「当前身份」「视图模式」同级（总纲 §2.10）。
 *
 * 与视图模式（A/B/C）**正交**：视图模式决定「主界面用哪一套」，版式决定「这一套摆成几列」。
 * 平板上 A/B/C 都能用、各自变成宽屏摆法；手机上 A/B/C 仍是今天的单列摆法。两者都存
 * localStorage、都不跨设备共享、都不进任何接口入参与留痕。
 *
 * 判据**只有这一处**（`matchMedia`/阈值都封在本文件里）：页面/组件一律 `useLayout()` 读派生值，
 * 不得自己调 `matchMedia`——否则阈值会在多处漂移。
 *
 * 为什么不用 UA / `pointer: coarse` 探测设备类型：UA 不可靠（iPadOS 默认就伪装成 Mac，
 * 桌面浏览器也能伪装），而 `pointer: coarse` 会把触屏笔记本、带笔的平板一律判成平板。
 * 视口宽度是**能直接观察到、且在浏览器里立刻可验证**的那个事实。
 */
const STORAGE_KEY = 'dinnerorder.layout';

/**
 * 平板版的宽度阈值：视口 ≥ 900px 用平板版。
 *
 * 选 900 而不是 768：iPad 竖屏的现代机型（1024）与 iPad mini 竖屏（744）之间，宁可让 744
 * 走手机版（单列看着不空），也不要让 800px 的桌面窗口拿到一半的双列。阈值是**单一常量**，
 * 设置面板文案与 E2E 都引用它，改一处即可。
 */
export const TABLET_MIN_WIDTH = 900;

export type LayoutPreference = 'auto' | 'phone' | 'tablet';
/** 派生值：只读，不落存储。narrow = 今天那套单列；wide = 平板版 */
export type Layout = 'narrow' | 'wide';

export interface LayoutOption {
  id: LayoutPreference;
  name: string;
  desc: string;
}

/** 三选一的文案与「视图模式」同风格：每项一句人话说明取舍 */
export const LAYOUT_OPTIONS: readonly LayoutOption[] = [
  { id: 'auto', name: '自动（按屏幕宽度）', desc: '屏幕够宽用平板版、窄了用手机版 —— 默认' },
  { id: 'phone', name: '手机版', desc: '底部胶囊导航 + 单列窄条 —— 在哪台设备上都这么摆' },
  { id: 'tablet', name: '平板版', desc: '左侧竖排导航 + 双列用上宽度 —— 桌面小窗口里也能预览' },
] as const;

export const DEFAULT_LAYOUT_PREFERENCE: LayoutPreference = 'auto';

const TABLET_QUERY = `(min-width: ${TABLET_MIN_WIDTH}px)`;

/**
 * `matchMedia` 不可用（旧浏览器、隐私模式、非浏览器环境）时返回 null——调用方一律降级为
 * **手机版**（故事 57：降级而不是白屏）。查询对象缓存起来：`useSyncExternalStore` 的
 * `getSnapshot` 会在每次渲染时调用，每次新建一个 MediaQueryList 是无谓的开销。
 */
let cachedQuery: MediaQueryList | null | undefined;

function tabletQuery(): MediaQueryList | null {
  if (cachedQuery !== undefined) return cachedQuery;
  try {
    cachedQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(TABLET_QUERY)
        : null;
  } catch {
    cachedQuery = null;
  }
  return cachedQuery;
}

function subscribeWide(onChange: () => void): () => void {
  const query = tabletQuery();
  if (!query) return () => {};
  // 订阅 `change`：桌面浏览器拖窗口跨过阈值时**无需刷新**即可切换（故事 10）
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** 此刻窗口够不够宽（`matchMedia` 不可用 = 不够宽 = 手机版） */
function isWideViewport(): boolean {
  return tabletQuery()?.matches ?? false;
}

function isLayoutPreference(value: string | null): value is LayoutPreference {
  return value === 'auto' || value === 'phone' || value === 'tablet';
}

function readStoredPreference(): LayoutPreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // 认不出的值（手改过、旧版本写的）退回默认，而不是白屏
    return isLayoutPreference(stored) ? stored : DEFAULT_LAYOUT_PREFERENCE;
  } catch {
    // localStorage 不可用（隐私模式）：降级成「本次会话内有效」（故事 58）
    return DEFAULT_LAYOUT_PREFERENCE;
  }
}

function writeStoredPreference(preference: LayoutPreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 同上：存不下就只当次生效，界面不因此报错
  }
}

export interface LayoutContextValue {
  /** 人选的（auto / phone / tablet） */
  preference: LayoutPreference;
  /** 派生值：此刻实际生效的版式（页面/组件只读这个） */
  layout: Layout;
  setPreference(preference: LayoutPreference): void;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<LayoutPreference>(() => readStoredPreference());
  const wide = useSyncExternalStore(subscribeWide, isWideViewport, () => false);

  const setPreference = useCallback((next: LayoutPreference) => {
    setPreferenceState(next);
    writeStoredPreference(next);
  }, []);

  const layout: Layout =
    preference === 'tablet' ? 'wide' : preference === 'phone' ? 'narrow' : wide ? 'wide' : 'narrow';

  const value = useMemo<LayoutContextValue>(
    () => ({ preference, layout, setPreference }),
    [preference, layout, setPreference],
  );

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutContextValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error('useLayout 必须在 LayoutProvider 内使用');
  return value;
}
