import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { AppShell } from './AppShell';
import { routerBasename } from './config';
import { IdentityProvider } from './identity';
import { LayoutProvider } from './layout';
import { ViewModeProvider } from './viewMode';
import { FamilyView } from './routes/FamilyView';
import { GroceryView } from './routes/GroceryView';
import { LayoutRoute } from './routes/LayoutRoute';
import { NotFoundView } from './routes/Placeholders';
import { RecipeLibraryView } from './routes/RecipeLibraryView';
import { ReviewRoute } from './routes/ReviewRoute';
import { SlotView } from './routes/SlotView';

/**
 * Router 在 library 模式下按 basename 挂载（ADR-0003）：挂在 /dinner/ 时
 * 服务端注入的 basePath 让这里自动变成 '/dinner'，路由写法不用改。
 */
const router = createBrowserRouter(
  [
    {
      path: '/',
      element: (
        <AppShell>
          {/* 两层分发：外层按版式（手机/平板）、内层按视图模式（A/B/C）。两者正交（总纲 §2.10） */}
          <LayoutRoute />
        </AppShell>
      ),
    },
    {
      // 定餐编辑器：详情页而不是弹层——手机上深链能直接分享/回退，也少一层「弹层没关干净」的状态
      path: '/slot/:slotId',
      element: (
        <AppShell>
          <SlotView />
        </AppShell>
      ),
    },
    {
      // 买菜清单（总纲 §2.7、S8）：三视图共用底部导航，买菜入口只有这一页
      path: '/grocery',
      element: (
        <AppShell>
          <GroceryView />
        </AppShell>
      ),
    },
    {
      path: '/family',
      element: (
        <AppShell>
          <FamilyView />
        </AppShell>
      ),
    },
    {
      // 餐后回顾：饭后餐卡的常驻入口（不弹窗不推送，总纲 §2.5）
      path: '/review',
      element: (
        <AppShell>
          <ReviewRoute />
        </AppShell>
      ),
    },
    {
      // 菜谱库（issue #30）：设置里钻进来的**从属页面**，不占主导航（`hideNav`）、
      // 不影响今天/买菜/回顾/家人这四页。顶部一个「← 设置」返回。
      path: '/recipes',
      element: (
        <AppShell hideNav>
          <RecipeLibraryView />
        </AppShell>
      ),
    },
    {
      path: '*',
      element: (
        <AppShell>
          <NotFoundView />
        </AppShell>
      ),
    },
  ],
  { basename: routerBasename },
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <IdentityProvider>
        {/* 「当前身份」「视图模式」「版式」同级（总纲 §2.10）：都是这台设备的偏好，都存 localStorage */}
        <ViewModeProvider>
          <LayoutProvider>
            <RouterProvider router={router} />
          </LayoutProvider>
        </ViewModeProvider>
      </IdentityProvider>
    </QueryClientProvider>
  );
}
