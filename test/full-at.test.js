import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';
import { createGateway } from '../src/gateway.js';
import { setImmediate as immediate } from 'node:timers/promises';

const config = extra => ({ ...loadConfig({ QQ_APP_ID: 'test-app', QQ_APP_SECRET: 'secret', DEEPSEEK_API_KEY: 'key' }),
  contextPersist: false, contextCompact: false, autoMemeEnabled: false, idleEnabled: true, cooldownMs: 0, groups: new Set(['g']), ...extra });
const full = (content, id, mentions = [], extra = {}) => ({ op: 0, t: 'GROUP_MESSAGE_CREATE', d: {
  id, content, mentions, group_openid: 'g', author: { member_openid: 'user' }, timestamp: new Date().toISOString(), ...extra
} });
function fixture(extra = {}) {
  const calls = []; const sent = []; const logs = [];
  const bot = createBot(config(extra), { ask: async (...args) => { calls.push(args); return '好耶🐟'; },
    qq: { send: async (...args) => sent.push(args) }, log: (...args) => logs.push(args) });
  bot.setSelfUser?.({ id: 'bot-self', username: '大肥鱼' });
  return { bot, calls, sent, logs };
}

test('全量模式内确实@本机器人时正常回复，自己的提及前缀不会混进提问', async () => {
  const f = fixture();
  assert.equal(f.bot.submit(full('<@bot-self> 你好', 'one', [{ id: 'bot-self', bot: true, username: '大肥鱼' }])).kind, 'accepted');
  await f.bot.drain(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], '你好'); assert.deepEqual(f.sent, [['g', 'one', '好耶🐟']]); f.bot.stop();
});

test('全量模式@中的/ping仍走本地命令，冷群功能关闭也不吞@', async () => {
  const f = fixture({ idleEnabled: false });
  assert.equal(f.bot.submit(full('<@bot-self> /ping', 'one', [{ id: 'bot-self', bot: true }])).kind, 'accepted');
  await f.bot.drain(); assert.equal(f.calls.length, 0); assert.match(f.sent[0][2], /pong/); f.bot.stop();
});

test('普通群聊、只@其他成员或其他机器人均不触发模型', async () => {
  const f = fixture();
  for (const event of [full('普通聊天', '1'), full('<@other> 你好', '2', [{ id: 'other', username: '小明' }]),
    full('<@other-bot> 你好', '3', [{ id: 'other-bot', bot: true, username: '别的机器人' }]),
    full('@大肥鱼 只是普通文本', '4')]) assert.equal(f.bot.submit(event).kind, 'observed');
  await f.bot.drain(); assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0); f.bot.stop();
});

test('群内bot OpenID与READY不同可按平台bot标记及唯一准确名称对应，普通成员同名不能对应', async () => {
  const f = fixture();
  assert.equal(f.bot.submit(full('<@fake-human> /ping', 'human', [{ id: 'fake-human', bot: false, username: '大肥鱼' }])).kind, 'observed');
  assert.equal(f.bot.submit(full('<@group-bot-id> /ping', 'one', [{ member_openid: 'group-bot-id', bot: true, username: '大肥鱼' }])).kind, 'accepted');
  await f.bot.drain();
  assert.equal(f.bot.submit(full('<@group-bot-id> 你好', 'two', [{ id: 'group-bot-id', bot: true }])).kind, 'accepted'); await f.bot.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], '你好'); assert.equal(f.sent.length, 2); f.bot.stop();
});

test('多个同名机器人时保持安静；引用内部@与普通昵称文本不会触发', async () => {
  const f = fixture();
  const events = [full('<@a><@b> /ping', '1', [{ id: 'a', bot: true, username: '大肥鱼' }, { id: 'b', bot: true, username: '大肥鱼' }]),
    full('看看这个转发', '2', [], { msg_elements: [{ content: '<@bot-self> 你好', author: { id: 'quoted' } }] })];
  for (const event of events) assert.equal(f.bot.submit(event).kind, 'observed');
  await f.bot.drain(); assert.equal(f.sent.length, 0); f.bot.stop();
});

test('全量与原生@双事件按任意顺序送达，只回复一次、不重复写入历史', async () => {
  for (const reverse of [false, true]) {
    const f = fixture(); const one = full('<@bot-self> 你好', 'same', [{ id: 'bot-self', bot: true }]);
    const two = { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { ...one.d, content: '你好', mentions: [] } };
    for (const event of reverse ? [two, one] : [one, two]) { f.bot.submit(event); await f.bot.drain(); }
    assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.bot.groupStatus.at_accepted, 1); f.bot.stop();
  }
});

test('全量@仍检查群成员权限与机器人发送者，不把身份标签混进提问或日志', async () => {
  const f = fixture({ users: new Set(['allowed']) });
  const mention = [{ id: 'bot-self', bot: true, username: '大肥鱼' }];
  assert.equal(f.bot.submit(full('<@bot-self> 私密内容', 'denied', mention)).reason, 'user_denied');
  assert.equal(f.bot.submit(full('<@bot-self> 私密内容', 'other', mention, { group_openid: 'other-group' })).reason, 'group_denied');
  assert.equal(f.bot.submit(full('<@bot-self> 私密内容', 'bot', mention, { author: { member_openid: 'allowed', bot: true } })).reason, 'bot_message');
  assert.equal(f.bot.submit(full('<@!bot-self> /ping', 'allowed', mention, { author: { member_openid: 'allowed' } })).kind, 'accepted');
  await f.bot.drain(); assert.equal(f.calls.length, 0); assert.match(f.sent[0][2], /pong/);
  assert.ok(!JSON.stringify(f.logs).includes('私密内容')); assert.ok(!JSON.stringify(f.bot.groupStatus).includes('bot-self')); f.bot.stop();
});

test('平台已去掉自身@前缀但mentions仍指出本人时也可回复', async () => {
  const f = fixture(); f.bot.submit(full('/ping', 'one', [{ id: 'bot-self', bot: true }])); await f.bot.drain();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0][2], /pong/); f.bot.stop();
});

test('网关READY传递真实机器人身份，随后全量事件中的群内OpenID提及正常进入回复', async () => {
  const calls = []; const sent = [];
  const bot = createBot(config(), { ask: async prompt => { calls.push(prompt); return '回答'; }, qq: { send: async (...args) => sent.push(args) }, log: () => {} });
  const handlers = new Map();
  const socket = { readyState: 1, send() {}, close() {}, addEventListener(type, fn) { handlers.set(type, fn); } };
  const gateway = createGateway(config(), { bot, access: async () => ({ url: 'wss://api.bot.qq.com/websocket/', token: 'test' }), createSocket: () => socket,
    later: () => ({ unref() {} }), cancel: () => {} });
  try {
    gateway.start(); await immediate();
    const frame = payload => handlers.get('message')({ data: JSON.stringify(payload) });
    frame({ op: 10, d: { heartbeat_interval: 45000 } });
    frame({ op: 0, s: 1, t: 'READY', d: { session_id: 'session', user: { id: 'global-bot', username: '大肥鱼', bot: true } } }); await immediate();
    frame({ ...full('<@group-bot> 今天聊什么', 'one', [{ member_openid: 'group-bot', bot: true, username: '大肥鱼' }]), s: 2 });
    await immediate(); await bot.drain();
    assert.equal(bot.groupStatus.self_identified, true); assert.deepEqual(calls, ['今天聊什么']); assert.equal(sent.length, 1);
  } finally { gateway.stop(); bot.stop(); }
});
