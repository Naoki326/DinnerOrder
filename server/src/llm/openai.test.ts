import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createOpenAiLlmClient } from './openai.js';
import { LlmCallError } from './types.js';

/**
 * 真实客户端的接线（不打外部端点）：起一个**本机**的 OpenAI 兼容桩，
 * 验三件事——出参两档拼对了没有、错误转成了什么、DEBUG=1 落盘时有没有把 key 写进去。
 *
 * 为什么值得单独测：`response_format` 的形状与「不打印密钥」都是 silently-fail 的地方——
 * 拼错档位只会在真调用时表现为「模型没听话」，而日志里混进 key 更是没人会主动去看的错。
 */
const API_KEY = 'test-key-should-never-appear-in-logs';

interface Stub {
  url: string;
  /** 最近一次收到的请求体 */
  lastBody: () => Record<string, unknown>;
  lastAuthorization: () => string | undefined;
  close: () => Promise<void>;
}

async function startStub(handler?: (body: Record<string, unknown>) => { status: number; body: unknown }): Promise<Stub> {
  let lastBody: Record<string, unknown> = {};
  let lastAuthorization: string | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      lastAuthorization = request.headers.authorization;
      const result = handler?.(lastBody) ?? {
        status: 200,
        body: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'stub-model',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"dishes":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      };
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    lastBody: () => lastBody,
    lastAuthorization: () => lastAuthorization,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let stub: Stub | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await stub?.close();
  stub = undefined;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinnerorder-llm-'));
  tempDirs.push(dir);
  return dir;
}

function client(options: { debugLogDir?: string } = {}) {
  return createOpenAiLlmClient({
    apiKey: API_KEY,
    baseUrl: stub!.url,
    model: 'stub-model',
    debugLogDir: options.debugLogDir,
  });
}

describe('openai 客户端的接线', () => {
  it('json_object 档：出参带 response_format.type=json_object，回参给 text/model/耗时', async () => {
    stub = await startStub();
    const result = await client().complete({
      system: 'sys',
      prompt: '给一道菜',
      responseFormat: 'json_object',
      timeoutMs: 5000,
      temperature: 0.7,
    });

    expect(stub.lastBody().response_format).toEqual({ type: 'json_object' });
    expect(stub.lastBody().temperature).toBe(0.7);
    expect(result).toMatchObject({ text: '{"dishes":[]}', model: 'stub-model' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('json_schema 档：strict 与 schema 原样带上（真实部署靠它，本机端点不支持是环境差异）', async () => {
    stub = await startStub();
    const schema = { type: 'object', properties: { dishes: { type: 'array' } }, required: ['dishes'] };
    await client().complete({
      system: 'sys',
      prompt: 'p',
      responseFormat: 'json_schema',
      jsonSchema: schema,
      timeoutMs: 5000,
    });

    expect(stub.lastBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'meal_recommendation', strict: true, schema },
    });
  });

  it('端点报错 → LlmCallError（降级链据此换档重试），且错误正文里的 key 不进消息', async () => {
    stub = await startStub(() => ({
      status: 401,
      body: { error: { message: `invalid api key ${API_KEY}`, type: 'invalid_request_error' } },
    }));

    const failure = await client()
      .complete({ system: 's', prompt: 'p', responseFormat: 'json_object', timeoutMs: 5000 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LlmCallError);
    expect(String(failure)).toContain('LLM 调用失败');
  });

  it('DEBUG 落盘：请求/响应写进 data 日志目录，**不含 api key**', async () => {
    stub = await startStub();
    const dir = tempDir();
    await client({ debugLogDir: dir }).complete({
      system: '系统提示',
      prompt: '候选池',
      responseFormat: 'json_object',
      timeoutMs: 5000,
    });

    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const log = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
    expect(log).toContain('系统提示');
    expect(log).toContain('候选池');
    expect(log).not.toContain(API_KEY);
    expect(stub.lastAuthorization()).toBe(`Bearer ${API_KEY}`); // 请求确实带了凭据（只是不落盘）
  });

  it('不传 debugLogDir 就一个文件都不写（默认不落盘）', async () => {
    stub = await startStub();
    const dir = tempDir();
    await client().complete({ system: 's', prompt: 'p', responseFormat: 'json_object', timeoutMs: 5000 });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('工具面在 M1 直接抛错（工具调用留给 M2 的 MCP server）', async () => {
    stub = await startStub();
    const llm = client();
    expect(llm.listTools()).toEqual([]);
    await expect(llm.callTool('seasonal_ingredients', { month: 6 })).rejects.toThrow(LlmCallError);
  });
});
