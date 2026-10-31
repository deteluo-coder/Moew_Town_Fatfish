import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { keyPair, signBytes, verifyRequest } from '../src/signature.js';
import { createBot, limitReply } from '../src/bot.js';
import { createDeepseek, createQQ, UpstreamError } from '../src/clients.js';
import { createLogger } from '../src/log.js';

const realEnv = { QQ_APP_ID: 'test-app', QQ_APP_SECRET: 'test-secret', DEEPSEEK_API_KEY: 'test-key' };
const config = overrides => ({ ...loadConfig({}, { mock: true }), cooldownMs: 0, ...overrides });
const event = (id = 'm1', overrides = {}) => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id, group_openid: 'demo-group', author: { member_openid: 'user-1' },
  content: '你好', timestamp: new Date().toISOString(), ...overrides
} });

test('真实配置需要密钥；默认拒绝所有群；演示强制监听本机', () => {
  assert.throws(() => loadConfig({}), /QQ_APP_ID/);
  const live = loadConfig(realEnv);
  assert.equal(live.groups.size, 0);
  assert.equal(live.allowAllGroups, false);
  assert.equal(live.qqBase, 'https://api.bot.qq.com');
  assert.equal(live.model, 'deepseek-flash');
  assert.equal(live.contextPersist, true);
  assert.equal(live.contextCompact, true);
  assert.equal(live.contextTtlMs, 0);
  assert.equal(loadConfig({ HOST: '0.0.0.0' }, { mock: true }).host, '127.0.0.1');
  assert.throws(() => loadConfig({ ...realEnv, ALLOW_ALL_GROUPS: 'yes' }), /只能/);
  assert.throws(() => loadConfig({ ...realEnv, PORT: 'oops' }), /PORT/);
  assert.throws(() => loadConfig({ ...realEnv, DEEPSEEK_BASE_URL: 'http://example.com' }), /HTTPS/);
});

test('Ed25519 公钥与回调握手签名均匹配 QQ 官方向量', () => {
  const keys = keyPair('naOC0ocQE3shWLAfffVLB1rhYPG7');
  // 安全文档中的正文签名样例与其展示的正文无法对上；使用可复现的公钥及握手向量。
  assert.deepEqual([...keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)],
    [215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79, 227, 11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58]);
  const challenge = signBytes(keyPair('DG5g3B4j9X2KOErG'), '1725442341', 'Arq0D5A61EgUu4OxUvOp');
  assert.equal(challenge, '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706');
});

test('验签针对原始字节；拒绝篡改、过期和坏签名', () => {
  const keys = keyPair('test-secret');
  const now = 1725442341000;
  const timestamp = String(now / 1000);
  const raw = Buffer.from('{"op":0}');
  const headers = { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signBytes(keys, timestamp, raw) };
  assert.equal(verifyRequest(keys, headers, raw, now), true);
  assert.equal(verifyRequest(keys, headers, Buffer.from('{ "op":0}'), now), false);
  assert.equal(verifyRequest(keys, headers, raw, now + 301000), false);
  assert.equal(verifyRequest(keys, { ...headers, 'x-signature-ed25519': 'aa' }, raw, now), false);
});

function fixture(overrides = {}, dependencies = {}) {
  const replies = [];
  const prompts = [];
  const logs = [];
  const bot = createBot(config(overrides), {
    ask: async prompt => { prompts.push(prompt); return '模拟答案'; },
    qq: { send: async (...args) => replies.push(args) },
    log: (...args) => logs.push(args), ...dependencies
  });
  return { bot, replies, prompts, logs };
}

test('群与成员白名单在 AI 调用前生效，只处理群 @ 事件', async () => {
  const { bot, prompts } = fixture({ users: new Set(['permitted-user']) });
  assert.equal(bot.submit(event('1', { group_openid: 'other-group' })).reason, 'group_denied');
  assert.equal(bot.submit(event('2')).reason, 'user_denied');
  assert.equal(bot.submit({ ...event('3'), t: 'GROUP_MESSAGE_CREATE' }).kind, 'observed');
  assert.equal(bot.submit(event('4', { author: { member_openid: 'permitted-user', bot: true } })).reason, 'bot_message');
  await bot.drain();
  assert.equal(prompts.length, 0);
});

test('重复推送只调用一次 AI，并且只携带原 msg_id 发送一次', async () => {
  const { bot, prompts, replies } = fixture();
  assert.equal(bot.submit(event()).kind, 'accepted');
  assert.equal(bot.submit(event()).reason, 'duplicate');
  await bot.drain();
  assert.deepEqual(prompts, ['你好']);
  assert.deepEqual(replies, [['demo-group', 'm1', '模拟答案']]);
});

test('过期、未来、畸形、过长事件不会进入 AI', async () => {
  const { bot, prompts } = fixture({ maxInput: 2 });
  assert.equal(bot.submit(event('old', { timestamp: new Date(Date.now() - 241000).toISOString() })).reason, 'stale_message');
  assert.equal(bot.submit(event('future', { timestamp: new Date(Date.now() + 61000).toISOString() })).reason, 'stale_message');
  assert.equal(bot.submit(event('long', { content: '123' })).reason, 'input_too_long');
  assert.equal(bot.submit(event('invalid', { author: {} })).reason, 'invalid_message');
  await bot.drain();
  assert.equal(prompts.length, 0);
});

test('冷却时间和全局额度限制会阻止额外 AI 调用', async () => {
  const { bot, prompts } = fixture({ cooldownMs: 5000, perMinute: 1 });
  bot.submit(event('first'));
  assert.equal(bot.submit(event('second')).reason, 'rate_limited');
  await bot.drain();
  assert.equal(bot.submit(event('third', { author: { member_openid: 'user-2' } })).reason, 'rate_limited');
  assert.equal(prompts.length, 1);
});

test('并发满时不占用去重记录，容量释放后同一事件可重试', async () => {
  let finish;
  const { bot } = fixture({ concurrency: 1 }, { ask: () => new Promise(resolve => { finish = resolve; }) });
  bot.submit(event('one'));
  assert.equal(bot.submit(event('two')).kind, 'busy');
  await Promise.resolve();
  finish('ok');
  await bot.drain();
  assert.equal(bot.submit(event('two')).kind, 'accepted');
  await Promise.resolve();
  finish('ok');
  await bot.drain();
});

test('内存去重表有界；满时返回 busy，过期条目可回收', async () => {
  let time = Date.now();
  const { bot } = fixture({ maxEntries: 1, dedupTtl: 100 }, { now: () => time });
  bot.submit(event('one'));
  await bot.drain();
  assert.equal(bot.submit(event('two')).kind, 'busy');
  time += 101;
  assert.equal(bot.submit(event('two')).kind, 'accepted');
  await bot.drain();
});

test('/help 和 /ping 不调用 AI；停止后拒绝新任务', async () => {
  const { bot, prompts, replies } = fixture();
  bot.submit(event('ping', { content: '/ping' }));
  await bot.drain();
  bot.submit(event('help', { content: '/help' }));
  await bot.drain();
  assert.equal(prompts.length, 0);
  assert.match(replies[0][2], /pong/);
  bot.stop();
  assert.equal(bot.submit(event('stop')).kind, 'busy');
});

test('AI 故障会发固定提示；错误消息和聊天内容不会进入日志', async () => {
  const lines = [];
  const log = createLogger(line => lines.push(line));
  const { bot, replies } = fixture({}, { log, ask: async () => { throw new Error('secret-credential user-message'); } });
  bot.submit(event());
  await bot.drain();
  assert.match(replies[0][2], /暂时不可用/);
  assert.equal(lines.join('').includes('secret-credential'), false);
  assert.equal(lines.join('').includes('user-message'), false);
  log('info', 'safe', { authorization: 'hidden', content: 'hidden', user_openid: 'hidden' });
  assert.equal(lines.join('').includes('hidden'), false);
});

test('QQ 发送失败只记录诊断，不重发、不触发第二次 AI', async () => {
  let sends = 0;
  const { bot, logs, prompts } = fixture({}, { qq: { send: async () => {
    sends++;
    throw new UpstreamError('qq_send', 'api_error', 400, 40034005, 'trace-123');
  } } });
  bot.submit(event());
  await bot.drain();
  assert.equal(sends, 1);
  assert.equal(prompts.length, 1);
  assert.equal(logs.at(-1)[1], 'qq_reply_failed');
});

test('回复按 Unicode 字符截断，并清除 QQ 提及标记', () => {
  const reply = limitReply('<@123>' + '🐟'.repeat(200), 100);
  assert.ok(Array.from(reply).length <= 100);
  assert.ok(!reply.includes('<@'));
  assert.ok(!reply.includes('\uFFFD'));
});

const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test('没有历史时 DeepSeek 只携带系统提示和当前提问，关闭思考与流式输出', async () => {
  let request;
  const ask = createDeepseek(loadConfig(realEnv), async (url, init) => {
    request = { url, ...init };
    return response({ choices: [{ message: { content: '  你好  ' } }] });
  });
  assert.equal(await ask('我的问题'), '你好');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(request.body);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content, '我的问题');
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.stream, false);
  assert.equal(request.redirect, 'error');
});

test('DeepSeek HTTP 错误和空回复不会被当成有效回答', async () => {
  await assert.rejects(createDeepseek(loadConfig(realEnv), async () => response({ error: { message: 'private' } }, 429))('hi'),
    error => error.status === 429 && !error.message.includes('private'));
  await assert.rejects(createDeepseek(loadConfig(realEnv), async () => response({ choices: [] }))('hi'), /empty_reply/);
  await assert.rejects(createDeepseek(loadConfig(realEnv), async () => { throw Object.assign(new Error('secret'), { name: 'TimeoutError' }); })('hi'), /timeout/);
});

test('QQ token 缓存与并发复用，发送带 QQBot 鉴权、msg_id 和固定序号', async () => {
  let authCalls = 0;
  const sent = [];
  let time = 0;
  const qq = createQQ(loadConfig(realEnv), async (url, init) => {
    if (url.endsWith('getAppAccessToken')) {
      authCalls++;
      assert.deepEqual(JSON.parse(init.body), { appId: 'test-app', clientSecret: 'test-secret' });
      return response({ access_token: 'unit-test-token', expires_in: '7200' });
    }
    sent.push({ url, ...init });
    return response({ id: 'sent' });
  }, () => time);
  await Promise.all([qq.send('group', 'm1', 'hi'), qq.send('group', 'm2', 'hello')]);
  assert.equal(authCalls, 1);
  assert.equal(sent[0].headers.authorization, 'QQBot unit-test-token');
  assert.deepEqual(JSON.parse(sent[0].body), { content: 'hi', msg_type: 0, msg_id: 'm1', msg_seq: 1 });
  assert.equal(sent[0].url, 'https://api.bot.qq.com/v2/groups/group/messages');
  time = 7141000;
  await qq.send('group', 'm3', 'refresh');
  assert.equal(authCalls, 2);
});

test('QQ HTTP 200 的业务错误会失败，并保留安全的错误码与 trace', async () => {
  const authError = createQQ(loadConfig(realEnv), async () => response({ code: 100007, message: 'private' }));
  await assert.rejects(authError.send('g', 'm', 'hi'), e => e.apiCode === 100007 && !e.message.includes('private'));
  let calls = 0;
  const sendError = createQQ(loadConfig(realEnv), async () => ++calls === 1
    ? response({ access_token: 'token', expires_in: 7200 })
    : response({ err_code: 40034005, message: 'private', trace_id: 'trace-123' }));
  await assert.rejects(sendError.send('g', 'm', 'hi'), e => e.apiCode === 40034005 && e.trace === 'trace-123');
});

test('QQ 401 清除 token 缓存，但不会自动重发本条消息', async () => {
  let authCalls = 0;
  let sendCalls = 0;
  const qq = createQQ(loadConfig(realEnv), async url => {
    if (url.endsWith('getAppAccessToken')) {
      authCalls++;
      return response({ access_token: 'token', expires_in: 7200 });
    }
    sendCalls++;
    return sendCalls === 1 ? response({ code: 11243 }, 401) : response({ id: 'ok' });
  });
  await assert.rejects(qq.send('g', 'm1', 'hi'));
  assert.equal(sendCalls, 1);
  await qq.send('g', 'm2', 'hi');
  assert.equal(authCalls, 2);
});
