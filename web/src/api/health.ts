import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '../config';

export interface HealthResponse {
  ok: boolean;
  serverTime: string;
  basePath: string;
  llm: { tools: { name: string; description: string }[] };
}

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
