import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@dinnerorder/server/types';
import { apiUrl } from '../config';

// 线上形状来自 server（ADR-0002「共享类型由 server 导出」）
export type { HealthResponse };

async function fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(apiUrl('/health'), { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`健康检查失败：HTTP ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

/**
 * 冒烟查询：一条请求同时验证「前端能打到 API」「服务端时钟是注入的」「basePath 一致」。
 * 后续工单的领域查询照这个形状长。
 */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 60_000,
  });
}
