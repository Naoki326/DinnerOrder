import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { AppShell } from './AppShell';
import { routerBasename } from './config';
import { IdentityProvider } from './identity';
import { FamilyView } from './routes/FamilyView';
import { HomeView } from './routes/HomeView';
import { GroceryView, NotFoundView, ReviewView } from './routes/Placeholders';

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
          <HomeView />
        </AppShell>
      ),
    },
    {
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
        <RouterProvider router={router} />
      </IdentityProvider>
    </QueryClientProvider>
  );
}
