import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { createCommunityStore, communityKey, writeCommunityFile, communityInstruction, selfIntroduction } from '../src/community.js';
import { createDeepseek, createWebSearch, UpstreamError } from '../src/clients.js';
import { selectWebQuery, normalizeSearchResults, formatSourcedReply } from '../src/web-search.js';
import { createBot, limitReply } from '../src/bot.js';

const env = { QQ_APP_ID: 'test-app', QQ_APP_SECRET: 'secret', DEEPSEEK_API_KEY: 'test-key' };
const base = extra => ({ ...loadConfig(env), contextPersist: false, contextCompact: false, autoMemeEnabled: false,
  cooldownMs: 0, communityEnabled: true, webSearchEnabled: true, groups: new Set(['g']), ...extra });
const background = { school: '台州中学西校区', club: '喵喵镇', groupDescription: '台州中学西校区动漫社“喵喵镇”的群聊',
  ownerBackground: '群主是最初一代创始人，也是大肥鱼的主人。' };
const key = Buffer.alloc(32, 7);
const user = (id, username, role) => ({ member_openid: id, ...(username ? { username } : {}), ...(role ? { member_role: role } : {}) });
function fixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fatfish-community-'));
  const config = base({ communityDataDir: directory, ...extra });
  writeCommunityFile(path.join(directory, `${communityKey(config, 'g')}.settings.json`), { version: 1, background });
  const store = createCommunityStore(config, { aliasKey: key });
  return { directory, config, store, cleanup() {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'fatfish-community-'));
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}
const event = (content, id, author = user('u', '小明', 'member'), extra = {}) => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id, content, group_openid: 'g', author, timestamp: new Date().toISOString(), ...extra
} });
const json = data => new Response(JSON.stringify(data));

test('固定背景只用于配置的群，清晰保留学校、社团及创始人信息', () => {
  const f = fixture();
  try {
    const observed = f.store.observe('g', user('owner', '镇长', 'owner'));
    const context = f.store.context('g', observed);
    assert.deepEqual(context.background, background);
    assert.match(communityInstruction(context), /最初一代创始人/);
    assert.equal(context.participants[0].role, 'owner');
    const other = f.store.context('other', f.store.observe('other', user('u')));
    assert.equal(other.background, undefined);
    assert.ok(!communityInstruction(other).includes('最初一代创始人'));
  } finally { f.cleanup(); }
});

test('同名成员保持不同身份；昵称和身份重启可恢复，磁盘不含原始OpenID', () => {
  const f = fixture();
  try {
    const a = f.store.observe('g', user('raw-openid-one', '小明', 'member'));
    const b = f.store.observe('g', user('raw-openid-two', '小明', 'member'), [user('raw-openid-one', '小明')]);
    assert.notEqual(a.current, b.current);
    const context = f.store.context('g', b, [{ role: 'user', name: a.current, content: '我的偏好' }]);
    assert.equal(context.participants.length, 2);
    assert.ok(context.participants.every(item => item.sameName));
    const restored = createCommunityStore(f.config, { aliasKey: key });
    assert.equal(restored.observe('g', user('raw-openid-one')).current, a.current);
    const disk = fs.readdirSync(f.directory).map(file => fs.readFileSync(path.join(f.directory, file), 'utf8')).join('');
    assert.ok(!disk.includes('raw-openid-one') && !disk.includes('raw-openid-two'));
  } finally { f.cleanup(); }
});

test('自称、昵称和提及不能成为群主；真正的群主来自签名事件角色', () => {
  const f = fixture();
  try {
    f.store.observe('g', user('real-owner', '镇长', 'owner'));
    const observed = f.store.observe('g', user('member', '主人', 'member'), [user('fake-mentioned', '创始人', 'owner')]);
    f.store.setName('g', user('member', '主人', 'member'), '群主');
    const context = f.store.context('g', observed);
    assert.equal(context.participants.find(item => item.id === observed.current).role, 'member');
    assert.equal(context.participants.find(item => item.name === '创始人').role, 'unknown');
    assert.equal(context.participants.filter(item => item.role === 'owner').length, 1);
    const changed = f.store.observe('g', user('new-owner', '新群主', 'owner'));
    assert.equal(f.store.context('g', changed).participants.filter(item => item.role === 'owner').length, 1);
  } finally { f.cleanup(); }
});

test('本人设置的称呼不会被平台昵称变化覆盖，身份角色仍按平台更新', () => {
  const f = fixture();
  try {
    f.store.setName('g', user('u', '旧昵称', 'admin'), '小鱼');
    const observed = f.store.observe('g', user('u', '新昵称', 'member'));
    const current = f.store.context('g', observed).participants[0];
    assert.equal(current.name, '小鱼');
    assert.equal(current.role, 'member');
    assert.match(f.store.who('g', user('u')), /小鱼/);
    assert.match(f.store.setName('g', user('u'), '<@all>'), /1～24/);
  } finally { f.cleanup(); }
});

test('档案损坏时保留文件，固定背景仍可用，不凭空创建身份', () => {
  const f = fixture();
  try {
    f.store.observe('g', user('u', '小明', 'member'));
    const file = path.join(f.directory, `${communityKey(f.config, 'g')}.members.json`);
    fs.writeFileSync(file, 'corrupted');
    const observed = f.store.observe('g', user('u', '小明', 'owner'));
    const context = f.store.context('g', observed);
    assert.equal(context.profilesUnavailable, true);
    assert.deepEqual(context.background, background);
    assert.deepEqual(context.participants, []);
    assert.equal(fs.readFileSync(file, 'utf8'), 'corrupted');
  } finally { f.cleanup(); }
});

test('身份档案容量有界，并优先保留已确认群主', () => {
  const f = fixture({ communityMaxMembers: 2 });
  try {
    f.store.observe('g', user('owner', '镇长', 'owner'));
    f.store.observe('g', user('1', '一号', 'member'));
    const observed = f.store.observe('g', user('2', '二号', 'member'));
    const data = JSON.parse(fs.readFileSync(path.join(f.directory, `${communityKey(f.config, 'g')}.members.json`), 'utf8')).data;
    assert.equal(Object.keys(data.members).length, 2);
    assert.ok(f.store.context('g', observed).participants.some(item => item.role === 'owner'));
  } finally { f.cleanup(); }
});

test('明确自我介绍可设称呼，含其他内容或要求别人操作的句子不误设', () => {
  assert.equal(selfIntroduction('我叫小明'), '小明');
  assert.equal(selfIntroduction('以后叫我镇长。'), '镇长');
  assert.equal(selfIntroduction('我叫你去写作业'), undefined);
  assert.equal(selfIntroduction('我叫小明，你呢？'), undefined);
});

test('称呼和我是谁不调用模型；清空会话仍保留固定背景和称呼', async () => {
  const f = fixture();
  try {
    const calls = [];
    const replies = [];
    const bot = createBot(f.config, { ask: async (...args) => { calls.push(args); return '正常回答'; },
      qq: { send: async (...args) => replies.push(args) }, log: () => {}, search: async () => [] });
    for (const [id, content] of [['1', '设置称呼 小鱼'], ['2', '我是谁'], ['3', '/reset'], ['4', '社团是什么']]) {
      bot.submit(event(content, id)); await bot.drain();
    }
    assert.equal(calls.length, 1);
    assert.match(replies[1][2], /小鱼/);
    assert.deepEqual(calls[0][4].community.background, background);
    assert.equal(calls[0][4].community.participants[0].name, '小鱼');
    assert.equal(calls[0][2], calls[0][4].community.current);
  } finally { f.cleanup(); }
});

test('模型收到固定背景和当前身份，但没有原始QQ标识', async () => {
  const f = fixture();
  try {
    const context = f.store.context('g', f.store.observe('g', user('private-raw-openid', '镇长', 'owner')));
    let body;
    const ask = createDeepseek(f.config, async (url, init) => { body = JSON.parse(init.body); return json({ choices: [{ message: { content: '知道啦' } }] }); });
    await ask('介绍社团', [], context.current, [], { community: context });
    assert.match(body.messages[0].content, /台州中学西校区/);
    assert.match(body.messages[0].content, /喵喵镇/);
    assert.match(body.messages[0].content, /owner/);
    assert.ok(!JSON.stringify(body).includes('private-raw-openid'));
  } finally { f.cleanup(); }
});

test('联网只对公开查询和最新资料触发，不把群友身份当搜索词', () => {
  const c = base();
  assert.equal(selectWebQuery('查资料 台州中学西校区官网', c), '台州中学西校区官网');
  assert.equal(selectWebQuery('最近有哪些新番上映', c), '最近有哪些新番上映');
  assert.equal(selectWebQuery('我是谁', c), undefined);
  assert.equal(selectWebQuery('查一下主人是谁', c), undefined);
  assert.equal(selectWebQuery('查一下QQ号123456789的真实身份', c), undefined);
  assert.equal(selectWebQuery('查一下小明的个人资料', c, { participants: [{ name: '小明' }] }), undefined);
  assert.equal(selectWebQuery('查资料 官网', { ...c, webSearchEnabled: false }), undefined);
});

const sources = [{ title: '学校官网', url: 'https://example.com/school', summary: '公开学校介绍', date: '2026-10-28' }];

test('网页结果过滤内网、重复与畸形链接，来源长度和回复总长度有界', () => {
  const results = normalizeSearchResults({ results: [{ title: '内网', url: 'https://127.0.0.1/x' }, ...sources,
    ...sources, { title: '', url: 'https://example.com/empty' }] });
  assert.equal(results.length, 1);
  for (const max of [100, 300, 1200]) assert.ok(Array.from(formatSourcedReply('答'.repeat(2000), results, max, limitReply)).length <= max);
});

test('搜索接口只发送本次公开搜索词，不携带聊天历史或身份信息', async () => {
  let request;
  const search = createWebSearch(base(), async (url, init) => { request = { url, ...init }; return json({ results: sources }); });
  const results = await search('学校官网');
  assert.equal(request.url, 'https://api.deepseek.com/v1/tools/search');
  assert.deepEqual(JSON.parse(request.body), { query: '学校官网', count: 3, need_content: false });
  assert.equal(results.length, 1);
});

test('网页正文作为普通参考资料发送，不能提升成系统指令', async () => {
  let body;
  const ask = createDeepseek(base(), async (url, init) => { body = JSON.parse(init.body); return json({ choices: [{ message: { content: '已核实' } }] }); });
  const answer = await ask('查资料', [], undefined, [], { web: { status: 'ok', results: [{ ...sources[0], summary: 'UNTRUSTED_WEB_TEXT' }] } });
  assert.ok(!body.messages[0].content.includes('UNTRUSTED_WEB_TEXT'));
  assert.equal(body.messages[1].name, 'web_search_material');
  assert.equal(body.messages[1].role, 'user');
  assert.match(body.messages[1].content, /UNTRUSTED_WEB_TEXT/);
  assert.equal(answer.sources.length, 1);
});

test('联网成功会把真实来源交给模型并附在回答中', async () => {
  const f = fixture();
  try {
    let options;
    const replies = [];
    const bot = createBot(f.config, { ask: async (prompt, history, speaker, images, opts) => {
      options = opts; return { reply: '这是公开资料', sources: opts.web.results };
    }, search: async () => sources, qq: { send: async (...args) => replies.push(args) }, log: () => {} });
    bot.submit(event('查资料 学校官网', '1')); await bot.drain();
    assert.equal(options.web.status, 'ok');
    assert.match(replies[0][2], /资料来源/);
    assert.match(replies[0][2], /https:\/\/example.com\/school/);
  } finally { f.cleanup(); }
});

test('联网失败仍可生成文字，并明确把未核实状态交给模型', async () => {
  const f = fixture();
  try {
    let options;
    const replies = [];
    const bot = createBot(f.config, { ask: async (prompt, history, speaker, images, opts) => { options = opts; return '暂未核实最新信息'; },
      search: async () => { throw new Error('network'); }, qq: { send: async (...args) => replies.push(args) }, log: () => {} });
    bot.submit(event('最近有哪些新番上映', '1')); await bot.drain();
    assert.equal(options.web.status, 'unavailable');
    assert.equal(replies.length, 1);
    assert.match(replies[0][2], /暂未核实/);
  } finally { f.cleanup(); }
});

test('QQ明确拒绝来源URL时仅省略链接重试，最终记忆记录实际送达文字', async () => {
  const f = fixture();
  try {
    const deliveries = [];
    let calls = 0;
    const bot = createBot(f.config, { ask: async () => ({ reply: '公开资料', sources }), search: async () => sources,
      qq: { send: async (...args) => { deliveries.push(args); if (++calls === 1) throw new UpstreamError('qq_send', 'api_error', 400, 40054010); } }, log: () => {} });
    bot.submit(event('查资料 学校官网', '1')); await bot.drain();
    assert.equal(deliveries.length, 2);
    assert.match(deliveries[0][2], /https:/);
    assert.ok(!deliveries[1][2].includes('https:'));
    assert.match(deliveries[1][2], /学校官网/);
  } finally { f.cleanup(); }
});
