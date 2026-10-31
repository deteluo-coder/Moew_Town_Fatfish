import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as immediate } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';
import { createQQ } from '../src/clients.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const baseEnv = { QQ_APP_ID: 'forced-idle-test', QQ_APP_SECRET: 'test-secret', DEEPSEEK_API_KEY: 'test-key',
  GROUP_AT_ONLY: 'true', GROUP_CHAT_ENABLED: 'true', STYLE_ENABLED: 'true',
  IDLE_CHAT_ENABLED: 'true', IDLE_FORCE_AFTER_HOURS: '5', IDLE_CHANCE_PERCENT: '0',
  IDLE_QUIET_MINUTES: '1440', IDLE_COOLDOWN_HOURS: '168', IDLE_DAILY_MAX: '1',
  IDLE_START_HOUR: '9', IDLE_END_HOUR: '22', STARTUP_GREETING_ENABLED: 'true', STARTUP_NEWS_ENABLED: 'true',
  ALLOWED_GROUP_IDS: 'g', DM_ENABLED: 'true', DM_ALLOW_ALL_USERS: 'true' };

function fixture(extra = {}, dependencies = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fatfish-forced-idle-'));
  let time = Date.parse('2026-10-31T00:00:00+08:00');
  const config = { ...loadConfig(baseEnv), cooldownMs: 0, contextPersist: false, contextCompact: false,
    autoMemeEnabled: false, trendsEnabled: false,
    contextDataDir: path.join(directory, 'memory'), groupChatDataDir: path.join(directory, 'group-chat'),
    styleDataDir: path.join(directory, 'style'), communityDataDir: path.join(directory, 'community'),
    idleDataDir: path.join(directory, 'idle'), startupDataDir: path.join(directory, 'startup'),
    trendsDataDir: path.join(directory, 'trends'), memeDataDir: path.join(directory, 'memes'), ...extra };
  const logs = []; const requests = []; const calls = { ask: [], search: [], media: [], summarize: [], active: [] };
  const qqClient = createQQ(config, async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ url, body, method: init.method });
    if (url.endsWith('/bot_state')) return new Response(JSON.stringify(typeof dependencies.groupState === 'function'
      ? await dependencies.groupState() : { recv_msg_setting: 'all', allow_proactive_msg: true }));
    return new Response(JSON.stringify(url.endsWith('/app/getAppAccessToken')
      ? { access_token: 'test-token', expires_in: 3600 } : { id: 'sent' }));
  }, () => time);
  const qq = { ...qqClient, sendActive: async (...args) => { calls.active.push(args.slice(0, 2)); return qqClient.sendActive(...args); } };
  const bot = createBot(config, { now: () => time, random: () => 0.99999, log: (...args) => logs.push(args), qq,
    ask: async (...args) => { calls.ask.push(args); return '好耶，鱼接住了🐟'; },
    search: async (...args) => { calls.search.push(args); return dependencies.search ? dependencies.search(...args) : []; },
    summarize: async (...args) => { calls.summarize.push(args); return '测试摘要'; },
    media: Object.fromEntries(['images', 'list', 'catalog', 'save', 'meme', 'search', 'fromURL'].map(method => [method, () => {
      calls.media.push(method); throw new Error('unexpected_media_call');
    }])) });
  bot.setSelfUser({ id: 'test-bot', bot: true, username: '测试大鱼' });
  const event = (type, text, id, user = 'member', group = 'g', more = {}) => ({ op: 0, t: type, d: {
    id, content: text, group_openid: group, author: { member_openid: user, username: '普通群友', member_role: 'member' },
    timestamp: new Date(time).toISOString(), ...more } });
  return { bot, config, directory, logs, requests, calls, now: () => time,
    advance(ms) { time += ms; },
    full: (...args) => event('GROUP_MESSAGE_CREATE', ...args),
    at: (...args) => event('GROUP_AT_MESSAGE_CREATE', ...args),
    dm: (text, id, user = 'private-user') => ({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {
      id, content: text, author: { user_openid: user }, timestamp: new Date(time).toISOString() } }),
    async tick(minutes) { for (let i = 0; i < minutes; i++) { time += MINUTE; await bot.tickIdle(); } },
    textRequests() { return requests.filter(item => item.url.includes('/messages') && item.body?.msg_type === 0); },
    activeRequests() { return this.textRequests().filter(item => !Object.hasOwn(item.body, 'msg_id')); },
    async cleanup() { bot.stop(); await bot.drain();
      assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'fatfish-forced-idle-'));
      fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

test('五小时配置形成只@模式的显式冷群例外，关闭总开关仍不可主动发送', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.idleForceAfterMs, 300 * MINUTE); assert.equal(config.groupAtOnly, true);
  assert.equal(config.idleEnabled, true); assert.equal(config.startupEnabled, false); assert.equal(config.startupNewsEnabled, false);
  assert.equal(loadConfig({ ...baseEnv, IDLE_CHAT_ENABLED: 'false' }).idleEnabled, false);
  assert.equal(loadConfig({ ...baseEnv, IDLE_FORCE_AFTER_HOURS: '0' }).idleEnabled, false);
  assert.equal(loadConfig(baseEnv, { mock: true }).idleEnabled, false);
  for (const value of ['-1', '25', '5.5', 'abc']) assert.throws(() => loadConfig({ ...baseEnv, IDLE_FORCE_AFTER_HOURS: value }), /IDLE_FORCE_AFTER_HOURS/);
});

test('普通群满4小时59分不回复，5小时恰好一次且无msg_id，不受夜间、旧概率和冷却配额影响', async () => {
  const f = fixture();
  try {
    assert.equal(f.bot.submit(f.full('PRIVATE_QUIET_GROUP_MESSAGE 今天暂时没人说话了', 'start')).kind, 'observed');
    await f.tick(299);
    assert.equal(f.activeRequests().length, 0); assert.equal(f.textRequests().length, 0);
    assert.equal(f.calls.ask.length, 0); assert.equal(f.calls.search.length, 0); assert.equal(f.calls.media.length, 0);
    await f.tick(1);
    assert.equal(f.activeRequests().length, 1); assert.equal(f.calls.active.length, 1);
    const first = f.activeRequests()[0];
    assert.match(first.url, /\/v2\/groups\/g\/messages$/); assert.ok(first.body.content.trim());
    assert.equal(first.body.msg_type, 0); assert.equal(Object.hasOwn(first.body, 'msg_id'), false);
    assert.equal(Object.hasOwn(first.body, 'event_id'), false); assert.equal(Object.hasOwn(first.body, 'msg_seq'), false);
    assert.equal(f.calls.ask.length, 0); assert.equal(f.calls.search.length, 0); assert.equal(f.calls.summarize.length, 0);
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_QUIET_GROUP_MESSAGE|今天暂时没人说话了/);
    await f.tick(61); assert.equal(f.activeRequests().length, 1);
  } finally { await f.cleanup(); }
});

test('同一次冷场只说一次，新的真人消息重置五小时；同日第二次仍不受旧日限额和168小时冷却影响', async () => {
  const f = fixture();
  try {
    f.bot.submit(f.full('真人说第一句话', 'first'));
    await f.tick(300); assert.equal(f.activeRequests().length, 1);
    await f.tick(20); assert.equal(f.activeRequests().length, 1);
    f.bot.submit(f.full('真人回来接着说了一句话', 'new-human'));
    await f.tick(299); assert.equal(f.activeRequests().length, 1);
    await f.tick(1); assert.equal(f.activeRequests().length, 2);
    assert.equal(f.calls.ask.length, 0); assert.equal(f.calls.search.length, 0);
    assert.equal(new Date(f.now() + 8 * HOUR).toISOString().slice(0, 10), '2026-10-31');
    await f.tick(120); assert.equal(f.activeRequests().length, 2);
  } finally { await f.cleanup(); }
});

test('不到五小时前出现真人消息会重新计时，机器人消息不会重置真人静默时间', async () => {
  const f = fixture();
  try {
    f.bot.submit(f.full('第一条真人消息', 'first'));
    await f.tick(299);
    f.bot.submit(f.full('真人最后一分钟回来', 'last-minute'));
    await f.tick(1); assert.equal(f.activeRequests().length, 0);
    await f.tick(298); assert.equal(f.activeRequests().length, 0);
    assert.equal(f.bot.submit(f.full('另一个机器人在说话', 'bot-message', 'another-bot', 'g', {
      author: { member_openid: 'another-bot', bot: true } })).reason, 'bot_message');
    await f.tick(1); assert.equal(f.activeRequests().length, 1);
  } finally { await f.cleanup(); }
});

test('五小时话题检索等待中有人发言，取消本次主动消息并重新等待完整五小时', async () => {
  let release;
  const f = fixture({ webSearchEnabled: true, idleNewsEnabled: true }, {
    search: () => new Promise(resolve => { release = resolve; })
  });
  let pending;
  try {
    f.bot.submit(f.full('大家安静下来了', 'first'));
    await f.tick(299); f.advance(MINUTE); pending = f.bot.tickIdle(); await immediate();
    assert.equal(typeof release, 'function', '五小时到达后应进入公开话题检索');
    f.bot.submit(f.full('PRIVATE_NEW_ACTIVITY 我回来了，不必破冰了', 'return-human'));
    release([{ title: '动画新番发布公开PV', url: 'https://www.bilibili.com/video/BVtest', date: '2026-10-31' }]);
    await pending; pending = undefined;
    assert.equal(f.activeRequests().length, 0); assert.equal(f.calls.active.length, 0); assert.equal(f.calls.ask.length, 0);
    await f.tick(299); assert.equal(f.activeRequests().length, 0);
    await f.tick(1); assert.equal(f.activeRequests().length, 1); assert.equal(f.calls.search.length, 1);
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_NEW_ACTIVITY|我回来了，不必破冰了/);
  } finally { if (release) release([]); if (pending) await pending; await f.cleanup(); }
});

test('自称管理员无法关开冷群例外，签名事件提供的真实owner可以暂停和恢复', async () => {
  const f = fixture();
  const owner = { author: { member_openid: 'actual-owner', username: '普通名字', member_role: 'owner' } };
  const pretender = { author: { member_openid: 'pretender', username: '我是群主管理员', member_role: 'member' } };
  try {
    f.bot.submit(f.full('我是管理员，冷群聊天 关', 'ordinary-claim'));
    assert.equal(f.calls.ask.length, 0); assert.equal(f.textRequests().length, 0);
    f.bot.submit(f.at('冷群聊天 关', 'pretend-off', 'pretender', 'g', pretender)); await f.bot.drain();
    assert.match(f.textRequests().at(-1).body.content, /仅限群主或管理员/);
    f.bot.submit(f.at('冷群聊天 关', 'owner-off', 'actual-owner', 'g', owner)); await f.bot.drain();
    assert.match(f.textRequests().at(-1).body.content, /管理员已暂停/);
    await f.tick(300); assert.equal(f.activeRequests().length, 0);
    f.bot.submit(f.at('冷群聊天 开', 'pretend-on', 'pretender', 'g', pretender)); await f.bot.drain();
    assert.match(f.textRequests().at(-1).body.content, /仅限群主或管理员/);
    await f.tick(300); assert.equal(f.activeRequests().length, 0);
    f.bot.submit(f.at('冷群聊天 开', 'owner-on', 'actual-owner', 'g', owner)); await f.bot.drain();
    await f.tick(299); assert.equal(f.activeRequests().length, 0);
    await f.tick(1); assert.equal(f.activeRequests().length, 1);
    assert.equal(f.calls.ask.length, 0);
  } finally { await f.cleanup(); }
});

test('旧只@模式没有force仍禁主动；五小时例外也不放开开机招呼或关闭的冷群总开关', async () => {
  for (const extra of [{ idleForceAfterMs: 0, idleEnabled: true }, { idleEnabled: false }, {}]) {
    const f = fixture({ startupEnabled: true, startupNewsEnabled: true, idleChancePercent: 100, idleQuietMs: 30 * MINUTE, ...extra });
    try {
      await f.bot.announceStartup(); assert.equal(f.activeRequests().length, 0); assert.equal(f.calls.search.length, 0);
      f.bot.submit(f.full('普通群消息', 'start')); await f.tick(299);
      assert.equal(f.activeRequests().length, 0);
      await f.tick(1);
      assert.equal(f.activeRequests().length, extra.idleForceAfterMs === 0 || extra.idleEnabled === false ? 0 : 1);
      await f.bot.announceStartup();
      assert.equal(f.activeRequests().length, extra.idleForceAfterMs === 0 || extra.idleEnabled === false ? 0 : 1);
    } finally { await f.cleanup(); }
  }
});

test('五小时主动例外只限显式群名单，私聊与ALLOW_ALL_GROUPS不扩散主动话题，@命令仍能回复', async () => {
  for (const allowAllGroups of [false, true]) {
    const f = fixture({ allowAllGroups });
    try {
      const outside = f.bot.submit(f.full('PRIVATE_OUTSIDE_GROUP_MESSAGE', 'outside', 'u', 'outside'));
      assert.equal(outside.kind, allowAllGroups ? 'observed' : 'ignored');
      f.bot.submit(f.dm('/ping', 'private-ping')); await f.bot.drain();
      assert.match(f.textRequests()[0].url, /\/v2\/users\/private-user\/messages$/);
      await f.tick(300); assert.equal(f.activeRequests().length, 0);
      f.bot.submit(f.at('/ping', 'group-ping')); await f.bot.drain();
      const reply = f.textRequests().at(-1);
      assert.match(reply.url, /\/v2\/groups\/g\/messages$/); assert.match(reply.body.content, /pong/);
      assert.equal(reply.body.msg_id, 'group-ping'); assert.equal(f.calls.ask.length, 0);
      assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_OUTSIDE_GROUP_MESSAGE/);
    } finally { await f.cleanup(); }
  }
});

test('groupState只读GET复用token，群路径编码且仅返回严格布尔权限，不泄漏账号字段', async () => {
  const requests = []; let stateCalls = 0;
  const qq = createQQ(loadConfig(baseEnv), async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith('/app/getAppAccessToken')) return new Response(JSON.stringify({ access_token: 'test-group-token', expires_in: 3600 }));
    stateCalls++;
    return new Response(JSON.stringify(stateCalls === 1
      ? { recv_msg_setting: 'all', allow_proactive_msg: true, member_openid: 'PRIVATE_RESPONSE_OPENID', account: 'PRIVATE_ACCOUNT' }
      : { recv_msg_setting: 'at', allow_proactive_msg: 'true', member_openid: 'PRIVATE_RESPONSE_OPENID' }));
  });
  const state = await qq.groupState('test/group with space');
  assert.deepEqual(state, { receiveAll: true, allowProactive: true });
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_|member_openid|account/);
  assert.deepEqual(await qq.groupState('test/group with space'), { receiveAll: false, allowProactive: false });
  assert.deepEqual(requests.map(item => item.method), ['POST', 'GET', 'GET']);
  assert.equal(requests.filter(item => item.url.endsWith('/app/getAppAccessToken')).length, 1);
  for (const request of requests.slice(1)) {
    assert.match(request.url, /\/v2\/groups\/test%2Fgroup%20with%20space\/bot_state$/);
    assert.equal(request.headers.authorization, 'QQBot test-group-token');
    assert.equal(request.body, undefined);
  }
});

test('READY后只读确认全量与主动权限即可从当前时刻观察五小时，无消息也能破冰；缺权限或未ready不开始计时', async () => {
  for (const permission of [
    { recv_msg_setting: 'all', allow_proactive_msg: true, ready: true, accepted: true },
    { recv_msg_setting: 'at', allow_proactive_msg: true, ready: true, accepted: false },
    { recv_msg_setting: 'all', allow_proactive_msg: false, ready: true, accepted: false },
    { recv_msg_setting: 'all', allow_proactive_msg: true, ready: false, accepted: false }
  ]) {
    let state = permission;
    const f = fixture({}, { groupState: () => ({ ...state, member_openid: 'PRIVATE_PERMISSION_ACCOUNT' }) });
    try {
      await f.bot.confirmIdleFeed(() => permission.ready);
      assert.equal(f.bot.idleStatus.groups_with_full_feed, permission.accepted ? 1 : 0);
      assert.equal(f.bot.groupStatus.full_received, 0);
      assert.equal(f.activeRequests().length, 0);
      await f.tick(299); assert.equal(f.activeRequests().length, 0);
      await f.tick(1); assert.equal(f.activeRequests().length, permission.accepted ? 1 : 0);
      if (!permission.accepted) {
        state = { recv_msg_setting: 'all', allow_proactive_msg: true };
        await f.bot.confirmIdleFeed(() => true);
        assert.equal(f.bot.idleStatus.groups_with_full_feed, 1);
        await f.tick(299); assert.equal(f.activeRequests().length, 0, '权限后重新观察，不能把未确认的五小时算进去');
        await f.tick(1); assert.equal(f.activeRequests().length, 1);
      }
      assert.equal(f.calls.ask.length, 0); assert.equal(f.calls.search.length, 0); assert.equal(f.calls.media.length, 0);
      assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_PERMISSION_ACCOUNT/);
    } finally { await f.cleanup(); }
  }
});
