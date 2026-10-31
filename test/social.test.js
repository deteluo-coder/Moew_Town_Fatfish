import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { createStyleStore, styleInstruction } from '../src/style.js';
import { createIdlePolicy, IDLE_TOPICS } from '../src/idle.js';
import { createBot } from '../src/bot.js';
import { createDeepseek, createQQ, UpstreamError } from '../src/clients.js';
import { socialFile } from '../src/social-state.js';
import { buildServer } from '../src/server.js';
import { keyPair, signBytes } from '../src/signature.js';
import { once } from 'node:events';

const env = { QQ_APP_ID: 'test-app', QQ_APP_SECRET: 'secret', DEEPSEEK_API_KEY: 'key', STYLE_ENABLED: 'true', IDLE_CHAT_ENABLED: 'true' };
const aliasKey = Buffer.alloc(32, 2);
function fixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fatfish-social-'));
  let timestamp = Date.parse('2026-10-28T09:00:00+08:00');
  const config = { ...loadConfig(env), groups: new Set(['g']), cooldownMs: 0, contextPersist: false,
    contextCompact: false, autoMemeEnabled: false, styleDataDir: path.join(directory, 'style'),
    idleDataDir: path.join(directory, 'idle'), idleChancePercent: 100, ...extra };
  return { directory, config, now: () => timestamp, advance(ms) { timestamp += ms; },
    cleanup() {
      assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'fatfish-social-'));
      fs.rmSync(directory, { recursive: true, force: true });
    } };
}
const options = f => ({ aliasKey, now: f.now, random: () => 0 });
const event = (f, type, id, content = '你好', author = { member_openid: 'u', member_role: 'member' }, group = 'g') => ({ op: 0, t: type, d: {
  id, group_openid: group, author, content, timestamp: new Date(f.now()).toISOString()
} });
const at = (f, id, content, author, group) => event(f, 'GROUP_AT_MESSAGE_CREATE', id, content, author, group);
const full = (f, id, content, author, group) => event(f, 'GROUP_MESSAGE_CREATE', id, content, author, group);
const json = value => new Response(JSON.stringify(value));

test('风格只存固定词表和统计，成员隔离，重启可恢复，提示有界', () => {
  const f = fixture();
  try {
    const store = createStyleStore(f.config, options(f));
    for (let i = 0; i < 8; i++) {
      store.observe('g', 'private-member-one', '好耶 哈哈✨ PRIVATE_RAW_SENTENCE');
      store.observe('g', 'private-member-two', '懂了 确实');
      f.advance(60000);
    }
    const restored = createStyleStore(f.config, options(f));
    const hint = restored.hint('g', 'private-member-one');
    assert.match(hint, /当前成员常用：哈哈、好耶/);
    assert.ok(Array.from(hint).length <= 140);
    assert.match(restored.hint('g', 'private-member-two'), /当前成员常用：确实、懂了/);
    const disk = fs.readFileSync(socialFile(f.config, f.config.styleDataDir, 'g'), 'utf8');
    assert.ok(!disk.includes('private-member') && !disk.includes('PRIVATE_RAW_SENTENCE'));
    assert.ok(!restored.hint('other', 'private-member-one').includes('群内常用'));
  } finally { f.cleanup(); }
});

test('敏感内容、链接、长文和指令不学习；刷屏每人每分钟只计一次', () => {
  const f = fixture();
  try {
    const store = createStyleStore(f.config, options(f));
    for (const text of ['密码 哈哈', 'https://example.com 哈哈', '字'.repeat(161), '/reset 哈哈', '123456789 哈哈']) store.observe('g', 'u', text);
    assert.match(store.status('g'), /有效样本 0/);
    for (let i = 0; i < 20; i++) store.observe('g', 'u', '哈哈');
    assert.match(store.status('g'), /有效样本 1/);
    f.advance(60000); store.observe('g', 'u', '好耶');
    assert.match(store.status('g'), /有效样本 2/);
  } finally { f.cleanup(); }
});

test('语气统计损坏时保留原文件，回复可回退通用风格', () => {
  const f = fixture();
  try {
    const store = createStyleStore(f.config, options(f)); store.observe('g', 'u', '哈哈');
    const file = socialFile(f.config, f.config.styleDataDir, 'g'); fs.writeFileSync(file, 'damaged');
    store.observe('g', 'u', '好耶'); store.reset('g');
    assert.equal(store.hint('g', 'u'), '先用通用轻松网络表达');
    assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
  } finally { f.cleanup(); }
});

test('风格在同一次回答中加入短指导，emoji有适用边界，不新增模型调用', async () => {
  const f = fixture();
  try {
    let body; let calls = 0;
    const ask = createDeepseek(f.config, async (url, init) => { calls++; body = JSON.parse(init.body); return json({ choices: [{ message: { content: '好耶🐟' } }] }); });
    await ask('一起追番吗', [], 'member_123', [], { style: '群内常用：好耶' });
    assert.equal(calls, 1); assert.match(body.messages[0].content, /1～2个emoji/);
    assert.match(body.messages[0].content, /严肃、悲伤/); assert.match(body.messages[0].content, /群内常用：好耶/);
    assert.equal(styleInstruction(undefined), '');
  } finally { f.cleanup(); }
});

test('没有普通消息流时不主动发送；只有@静默不视作群冷', () => {
  const f = fixture();
  try {
    const idle = createIdlePolicy(f.config, options(f));
    idle.activity('g'); f.advance(3600000);
    assert.equal(idle.reserve('g'), undefined); assert.match(idle.status('g'), /等待/);
    idle.activity('g', { full: true }); f.advance(3600000);
    assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});

test('启动等待、真实活跃、一次冷场只说一次、新活动和四小时间隔', () => {
  const f = fixture();
  try {
    const idle = createIdlePolicy(f.config, options(f)); idle.activity('g', { full: true });
    f.advance(3599999); assert.equal(idle.reserve('g'), undefined);
    f.advance(1); const lease = idle.reserve('g'); assert.ok(lease); assert.ok(idle.canSend(lease));
    idle.finish(lease, 'sent'); assert.equal(idle.context('g'), lease.text);
    f.advance(4 * 3600000); assert.equal(idle.reserve('g'), undefined);
    idle.activity('g', { full: true }); assert.equal(idle.reserve('g'), undefined);
    f.advance(3600000); const second = idle.reserve('g'); assert.ok(second); assert.notEqual(second.topic, lease.topic);
  } finally { f.cleanup(); }
});

test('每天额度跨重启保留，次日恢复，重启不立即插话', () => {
  const f = fixture({ idleDailyMax: 1 });
  try {
    let idle = createIdlePolicy(f.config, options(f)); idle.activity('g', { full: true }); f.advance(3600000);
    const lease = idle.reserve('g'); idle.finish(lease, 'sent');
    idle = createIdlePolicy(f.config, options(f)); assert.equal(idle.reserve('g'), undefined);
    idle.activity('g', { full: true }); f.advance(5 * 3600000); assert.equal(idle.reserve('g'), undefined);
    f.advance(24 * 3600000); idle.activity('g', { full: true }); f.advance(3600000);
    assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});

test('夜间不主动发送，休眠后重新等普通消息，允许全部群也不扩大发送范围', () => {
  const f = fixture({ allowAllGroups: true });
  try {
    const idle = createIdlePolicy(f.config, options(f));
    idle.activity('other', { full: true }); f.advance(3600000); assert.equal(idle.reserve('other'), undefined);
    idle.activity('g', { full: true }); f.advance(13 * 3600000); assert.equal(idle.reserve('g'), undefined);
    f.advance(11 * 3600000); idle.heartbeat(); assert.equal(idle.reserve('g'), undefined);
    idle.activity('g', { full: true }); f.advance(3600000); assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});

test('概率检查最多每15分钟一次，不随每分钟定时检查刷机会', () => {
  const f = fixture({ idleChancePercent: 25 });
  try {
    let checks = 0;
    const idle = createIdlePolicy(f.config, { now: f.now, random: () => { checks++; return 0.9; } });
    idle.activity('g', { full: true }); f.advance(3600000);
    for (let i = 0; i < 15; i++) { assert.equal(idle.reserve('g'), undefined); f.advance(60000); }
    assert.equal(checks, 1); idle.reserve('g'); assert.equal(checks, 2);
  } finally { f.cleanup(); }
});

test('群主管理员开关持久化；普通成员不能冒充管理员；发送失败后不反复发送', () => {
  const f = fixture();
  try {
    const idle = createIdlePolicy(f.config, options(f));
    assert.match(idle.command('g', '关', 'member'), /仅限/);
    idle.command('g', '关', 'owner'); idle.activity('g', { full: true }); f.advance(3600000);
    assert.equal(idle.reserve('g'), undefined);
    const restored = createIdlePolicy(f.config, options(f)); assert.match(restored.status('g'), /管理员已暂停/);
    idle.command('g', '开', 'admin'); f.advance(3600000); const lease = idle.reserve('g'); assert.ok(lease);
    idle.finish(lease, 'failed'); idle.activity('g'); f.advance(5 * 3600000); assert.equal(idle.reserve('g'), undefined);
    assert.match(idle.status('g'), /发送失败/);
  } finally { f.cleanup(); }
});

test('有新群消息或管理员暂停时取消尚未发送的主动话题', () => {
  const f = fixture();
  try {
    const idle = createIdlePolicy(f.config, options(f)); idle.activity('g', { full: true }); f.advance(3600000);
    const lease = idle.reserve('g'); assert.ok(idle.canSend(lease)); idle.activity('g'); assert.equal(idle.canSend(lease), false);
    f.advance(5 * 3600000); const next = idle.reserve('g'); assert.ok(next);
    idle.command('g', '关', 'owner'); assert.equal(idle.canSend(next), false);
  } finally { f.cleanup(); }
});

test('额度存储损坏时停止主动发送，不重置额度或覆盖文件', () => {
  const f = fixture();
  try {
    const idle = createIdlePolicy(f.config, options(f)); idle.command('g', '关', 'owner');
    const file = socialFile(f.config, f.config.idleDataDir, 'g'); fs.writeFileSync(file, 'damaged');
    idle.command('g', '开', 'owner'); idle.activity('g', { full: true }); f.advance(3600000);
    assert.equal(idle.reserve('g'), undefined); assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
  } finally { f.cleanup(); }
});

test('QQ主动消息不携带过期msg_id；鉴权后再检查群活跃，取消时不发消息', async () => {
  const f = fixture();
  try {
    const requests = [];
    const qq = createQQ(f.config, async (url, init) => { requests.push({ url, body: JSON.parse(init.body) });
      return json(url.endsWith('getAppAccessToken') ? { access_token: 'test', expires_in: 3600 } : { id: 'sent' }); });
    await qq.sendActive('g', '你好🐟');
    assert.deepEqual(requests[1].body, { content: '你好🐟', msg_type: 0 });
    assert.deepEqual(await qq.sendActive('g', '不应该发', () => false), { skipped: true });
    assert.equal(requests.length, 2);
  } finally { f.cleanup(); }
});

test('普通群消息不调用AI、不存语气和对话；双事件任意顺序不吞@回复', async () => {
  const f = fixture({ users: new Set(['u']) });
  try {
    let calls = 0; const replies = []; const opts = [];
    const bot = createBot(f.config, { now: f.now, random: () => 0, log: () => {}, ask: async (...args) => { calls++; opts.push(args[4]); return '好耶🐟'; },
      qq: { send: async (...args) => replies.push(args), sendActive: async () => {} } });
    assert.equal(bot.submit(full(f, 'ordinary', 'SECRET_ORDINARY_TEXT', { member_openid: 'not-permitted' })).kind, 'observed');
    assert.equal(bot.submit(full(f, 'same-one', '哈哈')).kind, 'observed');
    assert.equal(bot.submit(at(f, 'same-one', '哈哈')).kind, 'accepted'); await bot.drain();
    assert.equal(bot.submit(at(f, 'same-two', '好耶')).kind, 'accepted'); await bot.drain();
    assert.equal(bot.submit(full(f, 'same-two', '好耶')).kind, 'observed');
    assert.equal(calls, 2); assert.equal(replies.length, 2); assert.ok(opts.every(opt => typeof opt.style === 'string'));
    const disk = fs.readFileSync(socialFile(f.config, f.config.styleDataDir, 'g'), 'utf8'); assert.ok(!disk.includes('SECRET_ORDINARY_TEXT'));
    assert.equal(bot.idleStatus.groups_with_full_feed, 1);
    bot.stop();
  } finally { f.cleanup(); }
});

test('完整冷群流程使用本地话题，零模型调用，失败暂停，关闭后停止', async () => {
  const f = fixture();
  try {
    let calls = 0; const active = []; const logs = [];
    const bot = createBot(f.config, { now: f.now, random: () => 0, log: (...args) => logs.push(args), ask: async () => { calls++; return '回答'; },
      qq: { send: async () => {}, sendActive: async (group, text, valid) => { assert.ok(valid()); active.push(text); throw new UpstreamError('qq_send', 'api_error', 403); } } });
    bot.submit(full(f, 'one'));
    for (let i = 0; i < 61; i++) { f.advance(60000); await bot.tickIdle(); }
    assert.equal(calls, 0); assert.equal(active.length, 1); assert.ok(IDLE_TOPICS.includes(active[0]));
    assert.ok(logs.some(item => item[1] === 'idle_message_failed'));
    bot.submit(full(f, 'two')); for (let i = 0; i < 300; i++) { f.advance(60000); await bot.tickIdle(); }
    assert.equal(active.length, 1); bot.stop(); await bot.tickIdle(); await bot.drain();
  } finally { f.cleanup(); }
});

test('冷群联网期间有人说话就取消，不发送过时话题，不调用聊天模型', async () => {
  const f = fixture({ idleNewsEnabled: true, webSearchEnabled: true });
  try {
    let release; let entered; let ai = 0; const active = [];
    const searching = new Promise(resolve => { entered = resolve; });
    const bot = createBot(f.config, { now: f.now, random: () => 0, log: () => {},
      ask: async () => { ai++; return '回答'; }, search: () => { entered(); return new Promise(resolve => { release = resolve; }); },
      qq: { send: async () => {}, sendActive: async (...args) => active.push(args) } });
    bot.submit(full(f, 'start'));
    for (let i = 0; i < 59; i++) { f.advance(60000); await bot.tickIdle(); }
    f.advance(60000); const pending = bot.tickIdle(); await searching;
    bot.submit(full(f, 'new-human', '刚才在写作业'));
    release([{ title: '动画新番发布PV', url: 'https://www.bilibili.com/video/BVtest', date: '2026-10-28' }]);
    await pending; assert.equal(active.length, 0); assert.equal(ai, 0); bot.stop();
  } finally { f.cleanup(); }
});

test('冷群实际新闻文本进入后续上下文；QQ明确拒绝URL才移除链接重试', async () => {
  const f = fixture({ idleNewsEnabled: true, webSearchEnabled: true });
  try {
    let ai = 0; let opts; const active = [];
    const bot = createBot(f.config, { now: f.now, random: () => 0, log: () => {},
      ask: async (p, h, s, i, options) => { ai++; opts = options; return '刚才说的新番呀🐟'; },
      search: async () => [{ title: '动画新番发布PV', url: 'https://www.bilibili.com/video/BVtest', date: '2026-10-28' }],
      qq: { send: async () => {}, sendActive: async (g, text, valid) => { assert.ok(valid()); active.push(text);
        if (active.length === 1) throw new UpstreamError('qq_send', 'api_error', 400, 40054010); } } });
    bot.submit(full(f, 'start'));
    for (let i = 0; i < 60; i++) { f.advance(60000); await bot.tickIdle(); }
    assert.equal(active.length, 2); assert.equal(ai, 0);
    assert.match(active[0], /https:/); assert.doesNotMatch(active[1], /https:/);
    assert.match(active[1], /动画新番发布PV/);
    bot.submit(at(f, 'followup', '你刚才说的这个咋样')); await bot.drain();
    assert.equal(ai, 1); assert.equal(opts.idleContext, active[1]); bot.stop();
  } finally { f.cleanup(); }
});

test('语气和冷群命令不消耗模型；开关角色由签名事件提供', async () => {
  const f = fixture();
  try {
    let calls = 0; const replies = [];
    const bot = createBot(f.config, { now: f.now, log: () => {}, ask: async () => { calls++; return '回答'; }, qq: { send: async (...args) => replies.push(args[2]) } });
    for (const [id, prompt] of [['1', '语气状态'], ['2', '重置语气'], ['3', '冷群聊天 关']]) {
      bot.submit(at(f, id, prompt)); await bot.drain();
    }
    assert.equal(calls, 0); assert.match(replies[1], /仅限/); assert.match(replies[2], /仅限/);
    bot.submit(at(f, '4', '冷群聊天 关', { member_openid: 'u', member_role: 'owner' })); await bot.drain();
    assert.match(replies[3], /管理员已暂停/); bot.stop();
  } finally { f.cleanup(); }
});

test('配置默认不主动发言，错误时段和布尔值被拒绝，演示强制关闭', () => {
  const base = { QQ_APP_ID: 'a', QQ_APP_SECRET: 'b', DEEPSEEK_API_KEY: 'c' };
  assert.equal(loadConfig(base).idleEnabled, false);
  assert.throws(() => loadConfig({ ...base, IDLE_START_HOUR: '22', IDLE_END_HOUR: '9' }), /必须/);
  assert.throws(() => loadConfig({ ...base, STYLE_ENABLED: 'yes' }), /只能/);
  assert.equal(loadConfig(env, { mock: true }).styleEnabled, false);
  assert.equal(loadConfig(env, { mock: true }).idleEnabled, false);
});

test('发送等待跨过22点边界时取消，不能在夜间补发', () => {
  const f = fixture();
  try {
    const idle = createIdlePolicy(f.config, options(f));
    f.advance(11 * 3600000); idle.activity('g', { full: true }); f.advance(2 * 3600000 - 1000);
    const lease = idle.reserve('g'); assert.ok(lease); assert.equal(idle.canSend(lease), true);
    f.advance(1000); assert.equal(idle.canSend(lease), false);
  } finally { f.cleanup(); }
});

test('HTTP全量事件也必须验签；普通群正文不触发AI或公开输出', async () => {
  const f = fixture();
  let app;
  try {
    let calls = 0;
    app = buildServer(f.config, { now: f.now, log: () => {}, ask: async () => { calls++; return '答'; }, qq: { send: async () => {} } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const raw = JSON.stringify(full(f, 'one', 'PRIVATE_ORDINARY_CONTENT'));
    const post = headers => fetch(`${base}/qq/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
    assert.equal((await post({})).status, 401);
    assert.equal(app.bot.idleStatus.groups_with_full_feed, 0);
    const timestamp = String(Math.floor(f.now() / 1000));
    assert.equal((await post({ 'x-bot-appid': f.config.appId, 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signBytes(keyPair(f.config.appSecret), timestamp, raw) })).status, 200);
    assert.equal(app.bot.idleStatus.groups_with_full_feed, 1); assert.equal(calls, 0);
    const health = await fetch(`${base}/healthz`).then(r => r.text());
    assert.ok(!health.includes('PRIVATE_ORDINARY_CONTENT')); assert.ok(!fs.existsSync(f.config.styleDataDir));
  } finally {
    if (app) { app.bot.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.bot.drain(); }
    f.cleanup();
  }
});
