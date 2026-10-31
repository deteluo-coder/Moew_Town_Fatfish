import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';
import { createQQ, createDeepseek } from '../src/clients.js';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { buildServer } from '../src/server.js';
import { keyPair, signBytes } from '../src/signature.js';

const config = extra => ({ ...loadConfig({ QQ_APP_ID: 'test', QQ_APP_SECRET: 'secret', DEEPSEEK_API_KEY: 'key' }),
  contextPersist: false, contextCompact: false, autoMemeEnabled: false, cooldownMs: 0,
  dmEnabled: true, dmAllowAll: true, dmUsers: new Set(), groups: new Set(['g']), ...extra });
const dm = (text, id, user = 'private-user', extra = {}) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {
  id, content: text, author: { user_openid: user }, timestamp: new Date().toISOString(), ...extra
} });
const group = (text, id) => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id, content: text, author: { member_openid: 'private-user' }, group_openid: 'g', timestamp: new Date().toISOString()
} });

test('私聊使用user_openid和单聊发送接口，无需@即可应答', async () => {
  const calls = []; const replies = [];
  const bot = createBot(config(), { ask: async (...args) => { calls.push(args); return '你好🐟'; }, log: () => {},
    qq: { send: async () => assert.fail('private reply sent to group'), sendPrivate: async (...args) => replies.push(args) } });
  assert.equal(bot.submit(dm('你好', 'one')).kind, 'accepted'); await bot.drain();
  assert.equal(calls.length, 1); assert.equal(calls[0][4].privateChat, true);
  assert.deepEqual(replies, [['private-user', 'one', '你好🐟']]); bot.stop();
});

test('不同私聊与群聊的记忆隔离；私聊清空不影响群聊', async () => {
  const calls = [];
  const bot = createBot(config(), { ask: async (...args) => { calls.push(args); return '回答'; }, log: () => {},
    qq: { send: async () => {}, sendPrivate: async () => {} } });
  for (const event of [group('GROUP_SECRET', 'g1'), dm('DM_A_SECRET', 'a1'), dm('DM_B_SECRET', 'b1', 'another'),
    dm('/reset', 'a2'), dm('我的历史', 'a3'), group('群里历史', 'g2'), dm('另一个人的历史', 'b2', 'another')]) {
    bot.submit(event); await bot.drain();
  }
  assert.equal(calls.length, 6);
  assert.equal(calls[3][1].length, 0);
  assert.ok(JSON.stringify(calls[4][1]).includes('GROUP_SECRET'));
  assert.ok(!JSON.stringify(calls[4][1]).includes('DM_A_SECRET'));
  assert.ok(JSON.stringify(calls[5][1]).includes('DM_B_SECRET'));
  assert.ok(!JSON.stringify(calls[5][1]).includes('GROUP_SECRET')); bot.stop();
});

test('私聊默认关闭、可限成员；伪造群角色和群标识不会获得群管理权限', async () => {
  const make = c => createBot(c, { ask: async () => '答', log: () => {}, qq: { sendPrivate: async () => {} } });
  const disabled = make(config({ dmEnabled: false })); assert.equal(disabled.submit(dm('你好', '1')).reason, 'dm_disabled');
  const restricted = make(config({ dmAllowAll: false, dmUsers: new Set(['allowed']) }));
  assert.equal(restricted.submit(dm('你好', '2')).reason, 'dm_denied');
  assert.equal(restricted.submit(dm('你好', '3', 'allowed')).kind, 'accepted'); await restricted.drain();
  const replies = [];
  const bot = createBot(config(), { ask: async () => assert.fail('command called model'), log: () => {},
    qq: { sendPrivate: async (...args) => replies.push(args[2]) } });
  bot.submit(dm('冷群聊天 关', '4', 'attacker', { group_openid: 'g', author: { user_openid: 'attacker', member_role: 'owner' } }));
  await bot.drain(); assert.match(replies[0], /仅群聊/);
  disabled.stop(); restricted.stop(); bot.stop();
});

test('私聊重复事件只回复一次，媒体自检保留emoji并使用独立图片接口', async () => {
  const texts = []; const images = []; const uploads = [];
  const bot = createBot(config(), { ask: async () => assert.fail('self test called model'), log: () => {},
    media: { list: () => ['开心'], meme: () => ({ image: { ext: 'png', bytes: Buffer.from('image') } }) },
    qq: { sendPrivate: async (...args) => texts.push(args), uploadPrivateImage: async (...args) => { uploads.push(args); return 'private-file'; },
      sendPrivateImage: async (...args) => images.push(args) } });
  bot.submit(dm('媒体自检', 'one')); assert.equal(bot.submit(dm('媒体自检', 'one')).reason, 'duplicate'); await bot.drain();
  assert.equal(texts.length, 1); assert.match(texts[0][2], /🐟/); assert.equal(uploads[0][0], 'private-user');
  assert.deepEqual(images, [['private-user', 'one', 'private-file', 2]]); bot.stop();
});

test('私聊文字、图片上传和发送均使用/v2/users，上传不顺带发消息', async () => {
  const requests = [];
  const qq = createQQ(config(), async (url, init) => { requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(url.endsWith('getAppAccessToken') ? { access_token: 'test', expires_in: 3600 } :
      url.endsWith('/files') ? { file_info: 'private-file' } : { id: 'sent' })); });
  await qq.sendPrivate('p', 'm', '你好🐟✨');
  const info = await qq.uploadPrivateImage('p', { ext: 'png', bytes: Buffer.from('image') }); await qq.sendPrivateImage('p', 'm', info, 2);
  assert.ok(requests.slice(1).every(r => r.url.includes('/v2/users/p/')));
  assert.equal(requests[1].body.content, '你好🐟✨'); assert.equal(requests[2].body.srv_send_msg, false);
  assert.deepEqual(requests[3].body, { msg_type: 7, media: { file_info: 'private-file' }, msg_id: 'm', msg_seq: 2 });
});

test('私聊提示不声称在群聊，私聊角色不能引用群主身份映射', async () => {
  let body;
  const ask = createDeepseek(config(), async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '你好🐟' } }] })); });
  await ask('你好', [], undefined, [], { privateChat: true });
  assert.match(body.messages[0].content, /独立私聊/); assert.ok(!body.messages[0].content.includes('你在 QQ 群里参与多人对话'));
});

test('私聊记忆重启恢复，持久化文件不含原始用户OpenID，也不串到群聊', async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fatfish-private-'));
  try {
    const cfg = config({ contextPersist: true, contextDataDir: directory });
    const replies = []; const histories = [];
    const deps = { log: () => {}, ask: async (prompt, history) => { histories.push(history); return '已记住'; },
      qq: { sendPrivate: async (...args) => replies.push(args), send: async () => {} } };
    const first = createBot(cfg, deps); first.submit(dm('PRIVATE_PERSISTED_FACT', 'one')); await first.drain(); first.stop();
    const second = createBot(cfg, deps); second.submit(dm('记得什么', 'two')); await second.drain();
    second.submit(group('群里记得什么', 'three')); await second.drain(); second.stop();
    assert.ok(JSON.stringify(histories[1]).includes('PRIVATE_PERSISTED_FACT')); assert.equal(histories[2].length, 0);
    const disk = fs.readdirSync(directory, { recursive: true }).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
    assert.ok(!disk.includes('private-user'));
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'fatfish-private-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP私聊链路验签后ACK并回复，未签名消息不处理，健康检查只暴露计数', async () => {
  const replies = [];
  const cfg = config();
  const app = buildServer(cfg, { log: () => {}, qq: { sendPrivate: async (...args) => replies.push(args) }, ask: async () => assert.fail('ping called AI') });
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const raw = JSON.stringify(dm('/ping', 'one'));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const send = extra => fetch(`${base}/qq/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: raw });
    assert.equal((await send({})).status, 401); assert.equal(app.bot.privateStatus.received, 0);
    const response = await send({ 'x-bot-appid': cfg.appId, 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signBytes(keyPair(cfg.appSecret), timestamp, raw) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { op: 12 }); await app.bot.drain();
    assert.match(replies[0][2], /pong/); assert.equal(app.bot.privateStatus.received, 1);
    const health = await fetch(`${base}/healthz`).then(r => r.text()); assert.ok(!health.includes('private-user'));
  } finally { app.bot.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.bot.drain(); }
});
