import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { createPrivacy } from '../src/privacy.js';
import { createDeepseek, createSummarizer, createWebSearch, createQQ, UpstreamError } from '../src/clients.js';
import { createBot } from '../src/bot.js';
import { createStyleStore } from '../src/style.js';
import { createTrendStore } from '../src/trends.js';
import { socialFile } from '../src/social-state.js';
import { selectWebQuery } from '../src/web-search.js';

// 所有姓名、账号和凭证均为测试虚构值，测试不联网。
const env = { QQ_APP_ID: 'voice-test', QQ_APP_SECRET: 'fake-secret', DEEPSEEK_API_KEY: 'fake-key',
  PRIVATE_NAMES: '陈小雨,林ＡＡ', OWNER_DISPLAY_NAME: '镇长', OWNER_ALIASES: '陈小雨,小雨,镇长' };
const config = extra => ({ ...loadConfig(env), contextPersist: false, contextCompact: false, cooldownMs: 0,
  autoMemeEnabled: false, groups: new Set(['g']), dmEnabled: true, dmAllowAll: true, ...extra });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const completion = content => json({ choices: [{ finish_reason: 'stop', message: { content } }] });
const groupEvent = (content, id, author = {}) => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  content, id, group_openid: 'g', timestamp: new Date().toISOString(),
  author: { member_openid: 'test-member', member_role: 'member', ...author }
} });
const dmEvent = (content, id) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {
  content, id, timestamp: new Date().toISOString(), author: { user_openid: 'test-private-user' }
} });
function temporary(extra = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fatfish-voice-privacy-'));
  const value = config({ styleDataDir: path.join(directory, 'style'), communityDataDir: path.join(directory, 'community'),
    trendsDataDir: path.join(directory, 'trends'), idleDataDir: path.join(directory, 'idle'),
    startupDataDir: path.join(directory, 'startup'), ...extra });
  return { directory, config: value, cleanup() {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'fatfish-voice-privacy-'));
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}
const protectedName = /陈[\s\u200b-\u200f\u202a-\u202e·]*小[\s\u200b-\u200f\u202a-\u202e·]*雨|林ＡＡ|林AA/u;

test('本机可配置多个保护姓名及公开称呼；配置不会接受同名替换死循环', () => {
  const c = loadConfig({ ...env, PRIVATE_NAMES: ' 陈小雨 , 林ＡＡ,陈小雨 ' });
  assert.deepEqual(c.privateNames, ['陈小雨', '林ＡＡ']);
  assert.equal(c.ownerDisplayName, '镇长');
  assert.throws(() => loadConfig({ ...env, OWNER_DISPLAY_NAME: '陈小雨' }));
  assert.throws(() => loadConfig({ ...env, PRIVATE_NAMES: '林ＡＡ', OWNER_DISPLAY_NAME: '林AA同学' }));
  assert.throws(() => loadConfig({ ...env, PRIVATE_NAMES: '名字'.repeat(13) }));
});

test('隐私过滤覆盖原名、插空格/零宽和NFKC形式；递归不修改输入资料', () => {
  const privacy = createPrivacy(config());
  const original = { history: ['陈小雨说：乐🐟', { name: '陈\u3000小\u200b雨', fact: '林ＡＡ参加活动' }], count: 2, ok: true, empty: null };
  const filtered = privacy.value(original);
  assert.deepEqual(filtered, { history: ['镇长说：乐🐟', { name: '镇长', fact: '镇长参加活动' }], count: 2, ok: true, empty: null });
  assert.equal(privacy.text('陈小雨，你好～🐟；林ＡＡ也好！'), '镇长，你好～🐟；镇长也好！');
  assert.equal(original.history[1].name, '陈\u3000小\u200b雨');
  assert.equal(privacy.text('普通群友小陈和小雨一起听音乐'), '普通群友小陈和小雨一起听音乐');
  assert.equal(createPrivacy({}).text('陈小雨'), '陈小雨');
});

test('模型请求清洗系统背景、旧历史、社区身份、网页引用和本轮文本，纯文字回答也过滤', async () => {
  let request;
  const ask = createDeepseek(config({ systemPrompt: '维护者陈小雨，平时称镇长。' }), async (_url, init) => {
    request = JSON.parse(init.body); return completion('陈 小\u200b雨今天也绷不住了🐟');
  });
  const result = await ask('陈小雨是谁', [{ role: 'user', content: '旧记忆：陈小雨喜欢漫画' }], 'member_test', [], {
    style: '群友常说：乐', idleContext: '陈小雨发起活动', slang: [{ term: '乐', meaning: '陈小雨常说的反应' }],
    community: { background: { ownerBackground: '陈小雨是创始人' }, participants: [{ name: '陈小雨', role: 'owner' }] },
    web: { status: 'ok', results: [{ title: '陈小雨的公开资料', summary: '陈 小 雨参加活动', url: 'https://example.com/article' }] }
  });
  assert.doesNotMatch(JSON.stringify(request.messages), protectedName);
  assert.match(JSON.stringify(request.messages), /镇长/);
  assert.equal(result.reply, '镇长今天也绷不住了🐟');
});

test('启用JSON表情选择时仍过滤回答和传入的表情说明；私聊遵循相同姓名偏好', async () => {
  let request;
  const ask = createDeepseek(config(), async (_url, init) => {
    request = JSON.parse(init.body); return completion(JSON.stringify({ reply: '陈小雨，乐🐟', meme: '乐鱼' }));
  });
  const result = await ask('陈小雨', [], undefined, [], { privateChat: true,
    memes: [{ name: '乐鱼', description: '陈小雨觉得好笑时使用' }], style: '轻松短句' });
  assert.equal(request.response_format.type, 'json_object');
  assert.doesNotMatch(JSON.stringify(request.messages), protectedName);
  assert.equal(result.meme, '乐鱼');
  assert.doesNotMatch(result.reply, protectedName);
  assert.match(result.reply, /镇长/);
});

test('压缩旧记忆时先清洗姓名，摘要返回也不会重新带出原名', async () => {
  let request;
  const summarize = createSummarizer(config(), async (_url, init) => {
    request = JSON.parse(init.body); return completion('陈 小 雨喜欢漫画，之后称镇长。');
  });
  const summary = await summarize({ summary: '陈小雨是创始人', messages: [{ role: 'user', content: '林ＡＡ喜欢漫画' }], maxChars: 500 });
  assert.doesNotMatch(JSON.stringify(request.messages), protectedName);
  assert.doesNotMatch(summary, protectedName);
  assert.match(summary, /镇长喜欢漫画/);
});

test('所有保护姓名形式阻止自动或显式搜索；直接调用搜索客户端也先清洗', async () => {
  const c = config({ webSearchEnabled: true, webSearchAutomatic: true });
  for (const name of ['陈小雨', '陈 小\u200b雨', '林ＡＡ', '林AA']) {
    assert.equal(selectWebQuery(`查资料 ${name} 最近新闻`, c), undefined);
  }
  assert.equal(selectWebQuery('查资料 台州公开天气', c), '台州公开天气');
  let body;
  const search = createWebSearch(c, async (_url, init) => { body = JSON.parse(init.body); return json({ results: [] }); });
  await search('陈 小\u200b雨的公开资料');
  assert.equal(body.query, '镇长的公开资料');
});

test('QQ群回复、私聊回复和主动发言的底层文字出口全部清洗姓名', async () => {
  const messages = [];
  const qq = createQQ(config(), async (url, init) => {
    if (url.endsWith('/app/getAppAccessToken')) return json({ access_token: 'fake-token', expires_in: 3600 });
    messages.push({ url, body: JSON.parse(init.body) }); return json({ id: 'sent' });
  });
  await qq.send('g', 'm1', '陈小雨在吗');
  await qq.sendPrivate('user', 'm2', '陈 小\u200b雨，乐🐟');
  await qq.sendActive('g', '林ＡＡ也来接梗');
  assert.equal(messages.length, 3);
  assert.ok(messages.some(item => item.url.includes('/v2/users/')));
  for (const item of messages) { assert.doesNotMatch(item.body.content, protectedName); assert.match(item.body.content, /镇长/); }
  assert.equal(messages[2].body.msg_id, undefined);
});

test('绕过模型客户端的回答也在群聊及私聊最终出口过滤，成功记忆只保存过滤后的回复', async () => {
  const replies = []; const histories = [];
  const bot = createBot(config(), { log: () => {}, ask: async (_question, history) => {
    histories.push(history); return '陈 小\u200b雨，绷不住了🐟';
  }, qq: { send: async (_target, _id, text) => replies.push(text), sendPrivate: async (_target, _id, text) => replies.push(text) } });
  try {
    for (const event of [groupEvent('接梗', 'g1'), dmEvent('接梗', 'd1'), groupEvent('继续', 'g2'), dmEvent('继续', 'd2')]) {
      assert.equal(bot.submit(event).kind, 'accepted'); await bot.drain();
    }
    assert.equal(replies.length, 4);
    for (const text of replies) { assert.doesNotMatch(text, protectedName); assert.match(text, /镇长/); }
    for (const history of histories.slice(2)) { assert.ok(history.length); assert.doesNotMatch(JSON.stringify(history), protectedName); }
  } finally { bot.stop(); await bot.drain(); }
});

test('称呼设置和我是谁等非模型回显经过隐私过滤，角色没有因公开称呼改变', async () => {
  const f = temporary({ communityEnabled: true }); const replies = [];
  const bot = createBot(f.config, { log: () => {}, ask: async () => assert.fail('local identity command called model'),
    qq: { send: async (_target, _id, text) => replies.push(text) } });
  try {
    for (const event of [groupEvent('设置称呼 陈小雨', 'name'), groupEvent('我是谁', 'who')]) {
      assert.equal(bot.submit(event).kind, 'accepted'); await bot.drain();
    }
    assert.equal(replies.length, 2);
    assert.ok(replies.every(text => !protectedName.test(text)));
    assert.match(replies[1], /镇长/); assert.match(replies[1], /普通群成员/);
  } finally { bot.stop(); await bot.drain(); f.cleanup(); }
});

test('媒体说明及带来源回答的URL拒绝备用分支都不会绕过最终姓名过滤', async () => {
  const replies = []; let uploaded = 0; let sentImages = 0;
  const bot = createBot(config({ webSearchEnabled: true }), { log: () => {}, search: async () => [],
    media: { fromURL: async () => ({ image: { bytes: Buffer.from('fake') }, caption: '陈 小 雨的公开配图' }) },
    ask: async () => ({ reply: '陈小雨说绷🐟', sources: [{ title: '陈 小 雨引用的公开页面', url: 'https://example.com/article' }] }),
    qq: { uploadImage: async () => { uploaded++; return 'fake-file'; }, sendImage: async () => { sentImages++; },
      send: async (_target, _id, text) => { replies.push(text); if (text.includes('https://example.com/article')) throw new UpstreamError('qq_send', 'api_error', 400, 40054010); } } });
  try {
    for (const event of [groupEvent('发图 https://example.com/pic.png', 'pic'), groupEvent('接梗', 'reply')]) {
      assert.equal(bot.submit(event).kind, 'accepted'); await bot.drain();
    }
    assert.equal(uploaded, 1); assert.equal(sentImages, 1); assert.equal(replies.length, 3);
    assert.ok(replies.every(text => !protectedName.test(text)));
    assert.match(replies[0], /镇长的公开配图/);
    assert.ok(replies[1].includes('https://example.com/article'));
    assert.ok(!replies[2].includes('https://example.com/article'));
    assert.match(replies[2], /镇长引用的公开页面/);
  } finally { bot.stop(); await bot.drain(); }
});

test('新增五个梗在热梗列表可见，查列表不触发搜索或模型整理', () => {
  const f = temporary({ trendsEnabled: true }); let networkCalls = 0;
  try {
    const trends = createTrendStore(f.config, { search: async () => { networkCalls++; return []; }, extract: async () => { networkCalls++; return []; } });
    const list = trends.status(true);
    for (const term of ['闹麻了', '绷', '乐', '绷不住了', '扎啤']) assert.ok(list.includes(term));
    assert.equal(networkCalls, 0);
  } finally { f.cleanup(); }
});

test('语气学习不把音乐快乐紧绷当单字梗，长词优先且独立绷乐正常计数', () => {
  const f = temporary({ styleEnabled: true }); let timestamp = Date.now();
  try {
    const store = createStyleStore(f.config, { aliasKey: Buffer.alloc(32, 3), now: () => timestamp });
    store.observe('normal', 'u', '听音乐很快乐，刚才紧绷的感觉消失了');
    store.observe('long', 'u', '绷不住了');
    store.observe('single', 'u', '乐，绷！');
    store.observe('new', 'u', '闹麻了，扎啤');
    const words = group => JSON.parse(fs.readFileSync(socialFile(f.config, f.config.styleDataDir, group), 'utf8')).data.group.words;
    assert.equal(words('normal')['乐'], undefined); assert.equal(words('normal')['绷'], undefined);
    assert.equal(words('long')['绷不住了'], 1); assert.equal(words('long')['绷'], undefined); assert.equal(words('long')['绷不住'], undefined);
    assert.equal(words('single')['乐'], 1); assert.equal(words('single')['绷'], 1);
    assert.equal(words('new')['闹麻了'], 1); assert.equal(words('new')['扎啤'], 1);
  } finally { f.cleanup(); }
});

test('普通玩笑只调用一次回答模型且不新增检索，提示允许一句短梗结束', async () => {
  const f = temporary({ webSearchEnabled: true, styleEnabled: true }); let modelCalls = 0; let searches = 0; let body;
  const ask = createDeepseek(f.config, async (_url, init) => { modelCalls++; body = JSON.parse(init.body); return completion('乐🐟'); });
  const replies = [];
  const bot = createBot(f.config, { ask, log: () => {}, search: async () => { searches++; return []; },
    qq: { send: async (_target, _id, text) => replies.push(text) } });
  try {
    assert.equal(bot.submit(groupEvent('大肥鱼今天又想篡位了吗哈哈', 'joke')).kind, 'accepted'); await bot.drain();
    assert.equal(searches, 0); assert.equal(modelCalls, 1); assert.deepEqual(replies, ['乐🐟']);
    assert.match(body.messages[0].content, /1[～~]2句|短句|短梗/);
    assert.doesNotMatch(body.messages[0].content, /40[～~]120字/);
    assert.match(body.messages[0].content, /普通玩笑|明显玩笑/);
  } finally { bot.stop(); await bot.drain(); f.cleanup(); }
});
