import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMembers, type Member } from './api/members';

/**
 * 「这台设备当前是谁」——**设备本地的偏好**，不是服务端数据。
 *
 * 身份（家人画像）本身在服务端；但「这台手机现在用的是谁的身份」与「视图模式」同级
 * （总纲 §2.10 把两者并列），不进画像、不跨设备共享：共用 iPad 上切成谁、不影响手机。
 * 所以存在 localStorage，服务端不为它建表——服务端那张表迟早要处理「多设备同时用同一身份」
 * 这种它根本管不了的冲突。
 *
 * 无登录、无口令：切换即时生效，家庭 Wi-Fi 即门禁（总纲 §2.4）。
 */
const STORAGE_KEY = 'dinnerorder.currentIdentityId';

function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式等场景下 localStorage 可能不可用：降级成「本次会话内有效」，而不是白屏
    return null;
  }
}

function writeStoredId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 同上：存不下就只当次生效，界面不因此报错
  }
}

export interface IdentityContextValue {
  /** 家人列表（切换器与画像页共用一份查询） */
  members: Member[];
  /** 当前身份；家人列表还没回来时为 undefined */
  current: Member | undefined;
  /** 画像数据加载中（首屏身份条显示「…」而不是空名） */
  isPending: boolean;
  /** 家人列表读取失败（界面要说清是「没读回来」而不是「家里没人」） */
  isError: boolean;
  /** 切换当前身份：写本设备存储、立即对所有界面生效 */
  switchIdentity(id: string): void;
}

const IdentityContext = createContext<IdentityContextValue | undefined>(undefined);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const membersQuery = useMembers();
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);

  const [storedId, setStoredId] = useState<string | null>(() => readStoredId());

  // 家人数据到了之后校正一次：本设备记的 id 可能已被改名/删除（人在另一台设备上改过）
  useEffect(() => {
    if (members.length === 0) return;
    if (storedId !== null && members.some((member) => member.id === storedId)) return;
    // 缺省身份取掌勺者：家里最常拿着手机安排的是这个人（种子 is_cook=1 的妈妈）
    const fallback = members.find((member) => member.isCook) ?? members[0]!;
    setStoredId(fallback.id);
    writeStoredId(fallback.id);
  }, [members, storedId]);

  const switchIdentity = useCallback((id: string) => {
    setStoredId(id);
    writeStoredId(id);
  }, []);

  const current = useMemo(() => members.find((member) => member.id === storedId), [members, storedId]);

  const value = useMemo<IdentityContextValue>(
    () => ({
      members,
      current,
      isPending: membersQuery.isPending,
      isError: membersQuery.isError,
      switchIdentity,
    }),
    [members, current, membersQuery.isPending, membersQuery.isError, switchIdentity],
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}

export function useIdentity(): IdentityContextValue {
  const value = useContext(IdentityContext);
  if (!value) throw new Error('useIdentity 必须在 IdentityProvider 内使用');
  return value;
}
