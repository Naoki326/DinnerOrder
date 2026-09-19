import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { ZodSchema } from 'zod';

/**
 * 入参校验的统一入口。
 *
 * `@hono/zod-validator` 的缺省错误体是 `{success:false, error:{name:'ZodError',…}}`——与仓库其余
 * 错误响应（`{error:'not_found'}`、`{error:'unknown_ingredient', ingredientId}`）不是一种形状。
 * 两套形状并存时，前端要为「校验失败」单独写一条分支，且拿不到「哪个字段错了」。
 *
 * 这里把它统一成 `{error:'invalid_request', issues:[{path,message}]}`：
 * 形状与既有约定一致，且逐字段的错误信息原样带出（家人手机上填错年月时界面能说清）。
 */
export const validationErrorResponse = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (result.success) return;
  const issues = issuesOf(result.error);
  return c.json({ error: 'invalid_request', issues }, 400);
};

function issuesOf(error: unknown): { path: string; message: string }[] {
  if (!error || typeof error !== 'object' || !('issues' in error)) return [];
  const raw = (error as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return [];
  return raw.map((issue) => {
    const item = issue as { path?: unknown; message?: unknown };
    const path = Array.isArray(item.path) ? item.path.join('.') : '';
    return { path, message: typeof item.message === 'string' ? item.message : '入参不合法' };
  });
}

/** zod 校验中间件：失败时用仓库统一的错误形状 */
export function zodValidator<T extends ZodSchema>(target: 'query' | 'json', schema: T) {
  return zValidator(target, schema, validationErrorResponse);
}
