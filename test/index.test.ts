// mist 回归测试：node --experimental-strip-types --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicUrl,
  anthropicBody,
  buildAnthropicHeaders,
  cloakSystem,
  mergeBetas,
  clientUA,
  handleHealth,
} from '../src/index.ts';

const env = {
  PROXY_API_KEY: 'test-proxy-key',
  CLAUDE_OAUTH_TOKEN: 'sk-ant-oat01-fake',
  ANTHROPIC_API_KEY: 'sk-ant-api03-fake',
} as any;

function req(path: string, headers: Record<string, string> = {}, method = 'POST') {
  return new Request(`https://worker.example${path}`, { method, headers });
}

// ── 点段/编码点段逃逸：new URL 归一化后再守一次门 ──

test('点段与 %2e 编码逃逸被拒绝', () => {
  // 注意：new Request() 在 URL 解析层已归一化点段，所以这些请求到达
  // anthropicUrl 时已是归一化形态；'/v1/../../v1/models' 归一化后是合法的
  // /v1/models，自然放行。真正的防线是归一化后的第二道 /v1/ 前缀检查。
  assert.equal(anthropicUrl(req('/v1/../v1beta/models')), null);
  assert.equal(anthropicUrl(req('/v1/%2e%2e/v1beta/models')), null);
  assert.equal(anthropicUrl(req('/proxy/v1/../v1beta/models')), null);
  assert.equal(
    anthropicUrl(req('/v1/../../v1/models'))?.toString(),
    'https://api.anthropic.com/v1/models',
  );
  // 正常路径不受误伤
  assert.equal(
    anthropicUrl(req('/v1/messages/count_tokens'))?.toString(),
    'https://api.anthropic.com/v1/messages/count_tokens',
  );
});

// ── /health 分级：未鉴权只报活着 ──

test('/health 未鉴权不露配置指纹，鉴权后才给', async () => {
  const pub = (await handleHealth(env, false).json()) as any;
  assert.equal(pub.ok, true);
  assert.equal(pub.routes, undefined);
  const priv = (await handleHealth(env, true).json()) as any;
  assert.equal(priv.routes.anthropic.hasOAuthToken, true);
  assert.equal(priv.routes.anthropic.cloak, true);
});

test('端到端：匿名 /health 分级、带 key 给指纹、/v1 未鉴权 401', async () => {
  const { default: worker } = await import('../src/index.ts');
  const anon = await worker.fetch(req('/health', {}, 'GET'), env);
  const anonBody = (await anon.json()) as any;
  assert.equal(anonBody.ok, true);
  assert.equal(anonBody.routes, undefined);

  const authed = await worker.fetch(
    req('/health', { 'x-api-key': 'test-proxy-key' }, 'GET'),
    env,
  );
  const authedBody = (await authed.json()) as any;
  assert.equal(authedBody.routes.anthropic.hasOAuthToken, true);

  const denied = await worker.fetch(req('/v1/messages'), env);
  assert.equal(denied.status, 401);
});

// ── 开放代理逃逸（PR #1 评审主条）──

test('协议相对逃逸 /proxy//evil.com 被拒绝', () => {
  assert.equal(anthropicUrl(req('/proxy//evil.com/x')), null);
});

test('反斜杠形态 /proxy/\\@evil.com 被拒绝', () => {
  // WHATWG 会把 https URL path 里的 \ 规范成 /，变成 /proxy//@evil.com
  assert.equal(anthropicUrl(req('/proxy/\\@evil.com')), null);
});

test('/proxy 剥掉后非 /v1/ 路径被拒绝', () => {
  assert.equal(anthropicUrl(req('/proxy/v1beta/models')), null);
  assert.equal(anthropicUrl(req('/proxy/health')), null);
});

test('正常路径与双 /v1 前缀容错', () => {
  assert.equal(
    anthropicUrl(req('/v1/messages?beta=true'))?.toString(),
    'https://api.anthropic.com/v1/messages?beta=true',
  );
  assert.equal(
    anthropicUrl(req('/proxy/v1/v1/messages'))?.toString(),
    'https://api.anthropic.com/v1/messages',
  );
  assert.equal(anthropicUrl(req('/v1/messages'))?.origin, 'https://api.anthropic.com');
});

// ── content-type：只有改写过的 body 才标 JSON ──

test('cloak 改写过的 body 标 application/json', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, true, true, true);
  assert.equal(h.get('content-type'), 'application/json');
});

test('流式透传时保留客户端自己的 content-type', () => {
  const h = buildAnthropicHeaders(
    req('/v1/messages', { 'content-type': 'multipart/form-data; boundary=x' }),
    env,
    true,
    false,
    true,
  );
  assert.equal(h.get('content-type'), 'multipart/form-data; boundary=x');
});

test('流式透传且客户端没带 content-type 时不强加', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, true, false, true);
  assert.equal(h.get('content-type'), null);
});

test('GET /v1/models 不带 content-type', () => {
  const h = buildAnthropicHeaders(req('/v1/models', {}, 'GET'), env, true, false, false);
  assert.equal(h.get('content-type'), null);
});

// ── anthropic-beta：只在 /v1/messages 合并 ──

test('/v1/messages 合并 beta 全集（OAuth 含 oauth 标记）', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, true, true, true);
  const beta = h.get('anthropic-beta')!;
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('oauth-2025-04-20'));
});

test('x-api-key 模式不掺 oauth beta', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, false, true, true);
  const beta = h.get('anthropic-beta')!;
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(!beta.includes('oauth-2025-04-20'));
});

test('/v1/models 不动客户端的 beta，缺省不补', () => {
  const withBeta = buildAnthropicHeaders(
    req('/v1/models', { 'anthropic-beta': 'custom-beta-1' }, 'GET'),
    env, true, false, false,
  );
  assert.equal(withBeta.get('anthropic-beta'), 'custom-beta-1');
  const without = buildAnthropicHeaders(req('/v1/models', {}, 'GET'), env, true, false, false);
  assert.equal(without.get('anthropic-beta'), null);
});

// ── 认证头 ──

test('OAuth 用 Bearer 且清掉 x-api-key', () => {
  const h = buildAnthropicHeaders(req('/v1/messages', { 'x-api-key': 'client-key' }), env, true, true, true);
  assert.equal(h.get('authorization'), 'Bearer sk-ant-oat01-fake');
  assert.equal(h.get('x-api-key'), null);
});

test('API key 模式用 x-api-key 且清掉 authorization', () => {
  const h = buildAnthropicHeaders(req('/v1/messages', { authorization: 'Bearer x' }), env, false, true, true);
  assert.equal(h.get('x-api-key'), 'sk-ant-api03-fake');
  assert.equal(h.get('authorization'), null);
});

// ── 指纹优先级：客户端先，默认补缺口 ──

test('客户端自带 UA 透传，缺省时补默认/CLIENT_UA', () => {
  const own = buildAnthropicHeaders(req('/v1/messages', { 'user-agent': 'mine/1.0' }), env, true, true, true);
  assert.equal(own.get('user-agent'), 'mine/1.0');
  const filled = buildAnthropicHeaders(req('/v1/messages'), env, true, true, true);
  assert.ok(filled.get('user-agent')!.startsWith('claude-cli/'));
  assert.equal(clientUA({ CLIENT_UA: 'custom/9.9' } as any), 'custom/9.9');
});

// ── cloak 三种 system 形态 + 幂等 ──

const PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

test('cloak: 字符串 / 数组 / 缺省 / 幂等', () => {
  assert.ok(JSON.parse(cloakSystem('{"system":"原提示"}')).system.startsWith(PREFIX));
  const arr = JSON.parse(cloakSystem('{"system":[{"type":"text","text":"原提示"}]}'));
  assert.equal(arr.system[0].text, PREFIX);
  assert.equal(JSON.parse(cloakSystem('{"messages":[]}')).system, PREFIX);
  const once = cloakSystem('{"system":"原提示"}');
  assert.equal(cloakSystem(once), once);
  assert.equal(cloakSystem('not json'), 'not json');
});

test('/v1/messages 家族（count_tokens）合并 beta，非家族不合并', () => {
  const sub = buildAnthropicHeaders(req('/v1/messages/count_tokens'), env, true, true, true);
  assert.ok(sub.get('anthropic-beta')!.includes('claude-code-20250219'));
  const other = buildAnthropicHeaders(req('/v1/models'), env, true, false, false);
  assert.equal(other.get('anthropic-beta'), null);
});

// ── anthropicBody：cloak 只碰 messages 家族，二进制不损 ──

test('messages 家族 cloak 改写 JSON 并标 rewritten', async () => {
  const r = new Request('https://worker.example/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: '原提示', messages: [] }),
  });
  const out = await anthropicBody(r, env, '/v1/messages');
  assert.equal(out.rewritten, true);
  assert.ok(JSON.parse(out.body as string).system.startsWith(PREFIX));
});

test('cloak 未改动（已有前缀）时 rewritten=false', async () => {
  const body = JSON.stringify({ system: PREFIX + '\n\n原提示', messages: [] });
  const r = new Request('https://worker.example/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const out = await anthropicBody(r, env, '/v1/messages');
  assert.equal(out.rewritten, false);
});

test('二进制/multipart（/v1/files）字节不损、不被标 JSON', async () => {
  const bytes = new Uint8Array([0, 255, 1, 128, 254, 0, 66]);
  const r = new Request('https://worker.example/v1/files', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: bytes,
  });
  const out = await anthropicBody(r, env, '/v1/files');
  assert.equal(out.rewritten, false);
  // 双凭据都在 → 走 arrayBuffer 缓冲，内容必须逐字节一致
  const got = new Uint8Array(out.body as ArrayBuffer);
  assert.deepEqual([...got], [...bytes]);
  const h = buildAnthropicHeaders(
    req('/v1/files', { 'content-type': 'multipart/form-data; boundary=x' }),
    env, true, out.rewritten, false,
  );
  assert.equal(h.get('content-type'), 'multipart/form-data; boundary=x');
});

test('GET 无 body', async () => {
  const out = await anthropicBody(req('/v1/models', {}, 'GET'), env, '/v1/models');
  assert.equal(out.body, undefined);
  assert.equal(out.rewritten, false);
});

// ── mergeBetas 去重 ──

test('mergeBetas 与客户端 beta 取并集且去重', () => {
  const merged = mergeBetas('claude-code-20250219,custom-x', true);
  const parts = merged.split(',');
  assert.equal(new Set(parts).size, parts.length);
  assert.ok(parts.includes('custom-x'));
  assert.ok(parts.includes('oauth-2025-04-20'));
});
