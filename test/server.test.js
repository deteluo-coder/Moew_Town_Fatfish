import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { verify } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { keyPair, signBytes } from '../src/signature.js';

async function setup(t, { live = false, overrides = {}, dependencies = {} } = {}) {
  const config = { ...loadConfig(live ? {
    QQ_APP_ID: 'live-test-app', QQ_APP_SECRET: 'live-test-secret', DEEPSEEK_API_KEY: 'live-test-key', ALLOWED_GROUP_IDS: 'demo-group'
  } : {}, { mock: !live }), cooldownMs: 0, contextPersist: false, ...overrides };
  const app = buildServer(config, { log: () => {}, ...dependencies });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.bot.stop();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.bot.drain();
  });
  const keys = keyPair(config.appSecret);
  function post(body, { signed = true, headers = {} } = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(`${base}/qq/webhook`, { method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-bot-appid': config.appId,
        ...(signed ? { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signBytes(keys, timestamp, raw) } : {}), ...headers }
    });
  }
  return { ...app, config, keys, base, post };
}
const message = (id = 'test-message') => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id, group_openid: 'demo-group', author: { member_openid: 'test-user' }, content: '你好', timestamp: new Date().toISOString()
} });

test('HTTP 全链路：验签、ACK、模拟回复和重复推送去重', async t => {
  const app = await setup(t);
  const response = await app.post(JSON.stringify(message(), null, 2));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { op: 12 });
  await app.bot.drain();
  assert.equal(app.mockMessages.length, 1);
  assert.equal(app.mockMessages[0].msg_id, 'test-message');
  await app.post(message());
  await app.bot.drain();
  assert.equal(app.mockMessages.length, 1);
  assert.equal((await fetch(`${app.base}/healthz`).then(r => r.json())).mode, 'mock');
});

test('官方未签名 op=13 握手可通过；错误 AppID 被拒绝', async t => {
  const app = await setup(t);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const challenge = { op: 13, d: { plain_token: 'challenge-text', event_ts: timestamp } };
  const result = await app.post(challenge, { signed: false });
  const data = await result.json();
  assert.equal(result.status, 200);
  assert.equal(data.plain_token, 'challenge-text');
  assert.ok(verify(null, Buffer.from(timestamp + 'challenge-text'), app.keys.publicKey, Buffer.from(data.signature, 'hex')));
  assert.equal((await app.post(challenge, { signed: false, headers: { 'x-bot-appid': 'wrong' } })).status, 401);
  assert.equal((await app.post({ op: 13, d: { ...challenge.d, event_ts: '1' } }, { signed: false })).status, 400);
});

test('无签名、错误签名及错误 AppID 均不会触发 AI', async t => {
  let calls = 0;
  const app = await setup(t, { dependencies: { ask: async () => { calls++; return 'no'; } } });
  assert.equal((await app.post(message(), { signed: false })).status, 401);
  assert.equal((await app.post(message(), { headers: { 'x-signature-ed25519': '00'.repeat(64) } })).status, 401);
  assert.equal((await app.post(message(), { headers: { 'x-bot-appid': 'other' } })).status, 401);
  await app.bot.drain();
  assert.equal(calls, 0);
});

test('地址验证不能被当作任意消息的签名接口', async t => {
  const app = await setup(t);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const forgedMessage = JSON.stringify(message('forged'));
  const result = await app.post({ op: 13, d: { event_ts: timestamp, plain_token: forgedMessage } }, { signed: false });
  assert.equal(result.status, 400);
  assert.equal(app.mockMessages.length, 0);
});

test('ACK 不等待 AI；繁忙返回 503，释放后平台可重试', async t => {
  let finish;
  const app = await setup(t, { overrides: { concurrency: 1 }, dependencies: {
    ask: () => new Promise(resolve => { finish = resolve; })
  } });
  const first = await app.post(message('one'));
  assert.equal(first.status, 200);
  assert.equal(app.bot.inflight, 1);
  assert.equal((await app.post(message('two'))).status, 503);
  finish('ok');
  await app.bot.drain();
  assert.equal((await app.post(message('two'))).status, 200);
  finish('ok');
  await app.bot.drain();
});

test('真实模式没有模拟记录接口；无权限群即使签名合法也不调用 AI', async t => {
  let calls = 0;
  const app = await setup(t, { live: true, overrides: { groups: new Set() }, dependencies: {
    ask: async () => { calls++; return 'no'; }, qq: { send: async () => { throw new Error('should not send'); } }
  } });
  assert.equal((await fetch(`${app.base}/mock/messages`)).status, 404);
  assert.equal((await app.post(message())).status, 200);
  await app.bot.drain();
  assert.equal(calls, 0);
});

test('HTTP 路由、畸形 JSON、媒体类型和请求体上限', async t => {
  const app = await setup(t, { overrides: { maxBodyBytes: 1024 } });
  assert.equal((await fetch(`${app.base}/missing`)).status, 404);
  assert.equal((await fetch(`${app.base}/qq/webhook`)).status, 405);
  assert.equal((await app.post('{')).status, 400);
  assert.equal((await app.post(message(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await app.post(' '.repeat(1025))).status, 413);
  assert.equal((await app.post(null)).status, 200);
});
