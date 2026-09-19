import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { AppShell } from './AppShell';
import { routerBasename } from './config';
import { IdentityProvider } from './identity';
import { ViewModeProvider } from './viewMode';
import { FamilyView } from './routes/FamilyView';
import { GroceryView } from './routes/GroceryView';
import { HomeRoute } from './routes/HomeRoute';
import { NotFoundView } from './routes/Placeholders';
import { ReviewView } from './routes/ReviewView';
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
          {/* 三视图分发：视图模式是设备本地的呈现偏好（总纲 §2.10），默认 A */}
          <HomeRoute />
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
          <ReviewView />
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
        {/* 「当前身份」与「视图模式」同级（总纲 §2.10）：都是这台设备的偏好，都存 localStorage */}
        <ViewModeProvider>
          <RouterProvider router={router} />
        </ViewModeProvider>
      </IdentityProvider>
    </QueryClientProvider>
  );
}
