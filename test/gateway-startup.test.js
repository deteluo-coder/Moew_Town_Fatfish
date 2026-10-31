import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as immediate } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/gateway.js';
import { createStartupPolicy, WELCOMES } from '../src/startup.js';
import { createBot } from '../src/bot.js';
import { createDeepseek, createQQ } from '../src/clients.js';
import { createIdlePolicy } from '../src/idle.js';

const base = extra => ({ ...loadConfig({ QQ_APP_ID: 'a', QQ_APP_SECRET: 'b', DEEPSEEK_API_KEY: 'c' }),
  groups: new Set(['g']), contextPersist: false, contextCompact: false, cooldownMs: 0, autoMemeEnabled: false, ...extra });
class Socket {
  listeners = new Map(); readyState = 1; sent = [];
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  emit(type, data) { for (const fn of this.listeners.get(type) || []) fn(data); }
  frame(payload) { this.emit('message', { data: JSON.stringify(payload) }); }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close(code = 1000) { if (this.readyState !== 3) { this.readyState = 3; this.emit('close', { code }); } }
}
function gatewayFixture(extra = {}) {
  const sockets = []; const timers = new Set(); const logs = []; const payloads = [];
  let ready = 0; let pauses = 0;
  const bot = { submit: payload => { payloads.push(payload); return { kind: 'accepted' }; }, pauseIdleFeed: () => { pauses++; } };
  const gateway = createGateway(base(), { bot, access: async () => ({ url: 'wss://api.bot.qq.com/websocket/', token: 'PRIVATE_TEST_TOKEN' }),
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    log: (...args) => logs.push(args), onReady: () => { ready++; },
    later: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.add(t); return t; }, cancel: t => timers.delete(t), ...extra });
  async function connect() { gateway.start(); await immediate(); sockets.at(-1).frame({ op: 10, d: { heartbeat_interval: 45000 } }); }
  function fire(ms) { const t = [...timers].find(t => t.ms === ms); assert.ok(t, `no timer ${ms}`); timers.delete(t); t.fn(); }
  return { gateway, bot, sockets, logs, payloads, timers, connect, fire, get ready() { return ready; }, get pauses() { return pauses; } };
}

test('WSS只订阅群与C2C，握手后分发原事件，日志/状态不泄露凭证', async () => {
  const f = gatewayFixture();
  try {
    await f.connect(); const socket = f.sockets[0];
    assert.equal(socket.sent[0].op, 2); assert.equal(socket.sent[0].d.intents, 1 << 25); assert.deepEqual(socket.sent[0].d.shard, [0, 1]);
    socket.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'PRIVATE_SESSION' } }); await immediate();
    const event = { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'one' } }; socket.frame(event); await immediate();
    assert.deepEqual(f.payloads, [event]); assert.equal(f.gateway.status.state, 'ready'); assert.equal(f.ready, 1);
    assert.ok(!JSON.stringify([f.logs, f.gateway.status]).includes('PRIVATE'));
  } finally { f.gateway.stop(); }
});

test('心跳有ACK保持连接，缺ACK自动退避重连，并恢复处理过的序列号', async () => {
  const f = gatewayFixture();
  try {
    await f.connect(); const socket = f.sockets[0]; socket.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } }); await immediate();
    socket.frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 5, d: {} }); await immediate();
    f.fire(45000); assert.deepEqual(socket.sent.at(-1), { op: 1, d: 5 }); socket.frame({ op: 11 });
    f.fire(45000); assert.equal(f.gateway.status.state, 'ready');
    f.fire(45000); assert.equal(f.gateway.status.state, 'backoff'); assert.ok(f.pauses > 0);
    f.fire(5000); await immediate(); const next = f.sockets[1]; next.frame({ op: 10, d: { heartbeat_interval: 45000 } });
    assert.equal(next.sent[0].op, 6); assert.equal(next.sent[0].d.seq, 5);
    next.frame({ op: 0, t: 'RESUMED', s: 6, d: '' }); await immediate(); assert.equal(f.gateway.status.state, 'ready');
  } finally { f.gateway.stop(); }
});

test('会话无效重新鉴权，权限类关闭码停止重连，主动停止不再连接', async () => {
  const f = gatewayFixture();
  try {
    await f.connect(); f.sockets[0].frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } }); await immediate();
    f.sockets[0].frame({ op: 9, d: false }); f.fire(5000); await immediate();
    f.sockets[1].frame({ op: 10, d: { heartbeat_interval: 45000 } }); assert.equal(f.sockets[1].sent[0].op, 2);
    f.sockets[1].close(4014); assert.equal(f.gateway.status.state, 'blocked'); assert.equal(f.timers.size, 0);
  } finally { f.gateway.stop(); assert.equal(f.gateway.status.state, 'stopped'); }
});

test('繁忙事件等待容量，不丢消息；等待期间心跳ACK仍能处理', async () => {
  let calls = 0;
  const f = gatewayFixture({ bot: { submit: () => ({ kind: ++calls === 1 ? 'busy' : 'accepted' }) }, delay: async () => { f.sockets[0].frame({ op: 11 }); await immediate(); } });
  try {
    await f.connect(); f.sockets[0].frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } }); await immediate();
    f.fire(45000); f.sockets[0].frame({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 2, d: {} });
    await immediate(); await immediate(); assert.equal(calls, 2); assert.equal(f.gateway.status.state, 'ready');
    f.fire(45000); assert.equal(f.gateway.status.state, 'ready');
  } finally { f.gateway.stop(); }
});

test('QQ网关地址仅接受官方加密域名，不能把鉴权凭证发给任意主机', async () => {
  const qq = url => createQQ(base(), async endpoint => new Response(JSON.stringify(endpoint.endsWith('getAppAccessToken')
    ? { access_token: 'test', expires_in: 3600 } : { url })));
  assert.equal((await qq('wss://api.bot.qq.com/websocket/').gatewayInfo()).token, 'QQBot test');
  for (const url of ['ws://api.bot.qq.com/websocket/', 'wss://evil.example.com/', 'wss://api.bot.qq.com@evil.example.com/']) await assert.rejects(() => qq(url).gatewayInfo());
});

function diskFixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fatfish-startup-'));
  let time = Date.parse('2026-10-29T10:00:00+08:00');
  const config = base({ startupEnabled: true, startupDataDir: directory, idleDataDir: path.join(directory, 'idle'), ...extra });
  return { directory, config, now: () => time, advance(ms) { time += ms; }, cleanup() {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'fatfish-startup-'));
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

test('每次启动只给显式授权群打一次招呼，短时重启持久化冷却防刷屏', async () => {
  const f = diskFixture();
  try {
    let policy = createStartupPolicy(f.config, { now: f.now, random: () => 0 });
    assert.equal(policy.reserve('other'), undefined); const lease = policy.reserve('g'); assert.ok(lease);
    assert.equal(policy.reserve('g'), undefined); policy.finish(lease); assert.equal(await policy.welcome(), WELCOMES[0]);
    policy = createStartupPolicy(f.config, { now: f.now }); assert.equal(policy.reserve('g'), undefined);
    f.advance(600001); policy = createStartupPolicy(f.config, { now: f.now }); assert.ok(policy.reserve('g'));
  } finally { f.cleanup(); }
});

test('有来源的二次元标题可用于开场，12小时复用缓存，没来源不用假新闻', async () => {
  const f = diskFixture({ startupNewsEnabled: true });
  try {
    let calls = 0;
    const deps = { now: f.now, random: () => 0, search: async () => { calls++; return [{ title: '新番官方PV公开', summary: '公开动画话题', url: 'https://example.com/anime', date: '2026-10-29' }]; } };
    let policy = createStartupPolicy(f.config, deps); assert.match(await policy.welcome(), /新番官方PV公开/);
    policy = createStartupPolicy(f.config, deps); await policy.welcome(); assert.equal(calls, 1);
    f.advance(13 * 3600000); await policy.welcome(); assert.equal(calls, 2);
    const fallback = createStartupPolicy({ ...f.config, startupNewsEnabled: false }, { now: f.now, random: () => 0, search: () => assert.fail('disabled search') });
    assert.equal(await fallback.welcome(), WELCOMES[0]);
  } finally { f.cleanup(); }
});

test('过期标题或检索失败不包装成最新热点，损坏额度不覆盖原文件', async () => {
  const f = diskFixture({ startupNewsEnabled: true });
  try {
    const policy = createStartupPolicy(f.config, { now: f.now, random: () => 0, search: async () => [{ title: '动画旧消息', summary: '旧资料', url: 'https://example.com/old', date: '2025-01-01' }] });
    assert.equal(await policy.welcome(), WELCOMES[0]); policy.reserve('g');
    const groupFile = fs.readdirSync(f.directory).find(name => !name.startsWith('news-')); fs.writeFileSync(path.join(f.directory, groupFile), 'damaged');
    const restored = createStartupPolicy(f.config, { now: f.now }); assert.equal(restored.reserve('g'), undefined);
    assert.equal(fs.readFileSync(path.join(f.directory, groupFile), 'utf8'), 'damaged');
  } finally { f.cleanup(); }
});

test('上线招呼走主动接口、不伪造msg_id、不调用模型，断线重连不重复招呼', async () => {
  const f = diskFixture();
  try {
    const sent = [];
    const bot = createBot(f.config, { now: f.now, random: () => 0, ask: () => assert.fail('startup called LLM'), log: () => {},
      qq: { sendActive: async (...args) => { sent.push(args); assert.ok(args[2]()); } } });
    await bot.announceStartup(); await bot.announceStartup(); await bot.drain();
    assert.equal(sent.length, 1); assert.equal(sent[0][0], 'g'); assert.match(sent[0][1], /🐟/);
    bot.stop(); await bot.announceStartup(); assert.equal(sent.length, 1);
  } finally { f.cleanup(); }
});

test('主人确定称呼与可能称呼都进入固定提示，私聊也可理解但不能据昵称授予权限', async () => {
  const config = base({ ownerAliases: ['社长', '小林'], ownerPossibleAliases: ['lx'] });
  let body;
  const ask = createDeepseek(config, async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '知道啦' } }] })); });
  await ask('主人还有什么称呼', [], undefined, [], { privateChat: true });
  assert.match(body.messages[0].content, /社长、小林/); assert.match(body.messages[0].content, /lx大概率/); assert.match(body.messages[0].content, /不能仅凭同名/);
});

test('掉线会撤销冷群判定，恢复后重新收到普通群消息才能计时', () => {
  const f = diskFixture({ idleEnabled: true });
  try {
    const idle = createIdlePolicy(f.config, { now: f.now, random: () => 0 });
    idle.activity('g', { full: true }); f.advance(3600000); idle.disconnect(); assert.equal(idle.reserve('g'), undefined);
    idle.activity('g', { full: true }); f.advance(3600000); assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});
