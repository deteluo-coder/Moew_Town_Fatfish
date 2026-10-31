import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { createReactionPolicy } from '../src/reactions.js';
import { createDeepseek, createMemeDescriber, createQQ } from '../src/clients.js';
import { createBot } from '../src/bot.js';
import { createMedia } from '../src/media.js';

const env = { QQ_APP_ID: 'test', QQ_APP_SECRET: 'secret', DEEPSEEK_API_KEY: 'key' };
const config = extra => ({ ...loadConfig(env), contextPersist: false, contextCompact: false, cooldownMs: 0,
  autoMemePercent: 100, groups: new Set(['g']), ...extra });
const catalog = [{ name: '开心', description: '笑脸，开心、庆祝' }, { name: '疑惑', description: '不解、疑问' }];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXYkAAAAASUVORK5CYII=', 'base64');
const json = data => new Response(JSON.stringify(data));
const response = (value, finish_reason = 'stop') => json({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason }] });
const event = (content, id, extra = {}) => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id, group_openid: 'g', author: { member_openid: 'u' }, content, timestamp: new Date().toISOString(), ...extra
} });

test('自动表情默认概率25%、间隔5分钟；演示强制关闭，参数接受校验', () => {
  const c = loadConfig(env);
  assert.equal(c.autoMemeEnabled, true);
  assert.equal(c.autoMemePercent, 25);
  assert.equal(c.autoMemeCooldownMs, 300000);
  assert.equal(loadConfig({ AUTO_MEME_ENABLED: 'true' }, { mock: true }).autoMemeEnabled, false);
  assert.throws(() => loadConfig({ ...env, AUTO_MEME_ENABLED: 'yes' }));
  assert.throws(() => loadConfig({ ...env, AUTO_MEME_CHANCE_PERCENT: '101' }));
});

test('选图机会受概率、同群互斥与冷却约束，一次只允许尝试一张', () => {
  let time = 0;
  let dice = 0.9;
  const policy = createReactionPolicy(config({ autoMemePercent: 25 }), { now: () => time, random: () => dice });
  assert.equal(policy.acquire('g', () => catalog), undefined);
  dice = 0.1;
  const first = policy.acquire('g', () => catalog);
  assert.ok(first);
  assert.equal(policy.acquire('g', () => catalog), undefined);
  assert.equal(first.attempt('不存在'), false);
  assert.equal(first.attempt('开心'), true);
  assert.equal(first.attempt('疑惑'), false);
  first.release();
  assert.equal(first.attempt('开心'), false);
  assert.equal(policy.acquire('g', () => catalog), undefined);
  const other = policy.acquire('other', () => catalog);
  assert.ok(other); other.release();
  time = 300001;
  const next = policy.acquire('g', () => catalog);
  assert.deepEqual(next.catalog.map(item => item.name), ['疑惑']);
  next.release();
});

test('空库、禁用发图、严肃求助、容量占满时跳过；未选图不占冷却', () => {
  for (const overrides of [{ autoMemeEnabled: false }, { imageSendEnabled: false }, { autoMemePercent: 0 }, { mock: true }]) {
    assert.equal(createReactionPolicy(config(overrides)).acquire('g', () => catalog), undefined);
  }
  const policy = createReactionPolicy(config({ maxEntries: 1 }), { random: () => 0 });
  assert.equal(policy.acquire('g', () => []), undefined);
  assert.equal(policy.acquire('g', () => catalog, '朋友去世了，很难过'), undefined);
  assert.equal(policy.acquire('g', () => { throw new Error('disk'); }), undefined);
  const lease = policy.acquire('g', () => catalog);
  assert.equal(policy.acquire('other', () => catalog), undefined);
  lease.release();
  assert.ok(policy.acquire('other', () => catalog));
});

test('选图和回答共用一次 DeepSeek 请求，未知表情名称会被拒绝', async () => {
  let calls = 0;
  let body;
  const ask = createDeepseek(config(), async (url, init) => {
    calls++; body = JSON.parse(init.body);
    return response({ reply: '真不错！', meme: calls === 1 ? '开心' : '外部链接或不存在的名称' });
  });
  assert.deepEqual(await ask('好开心', [], undefined, [], { memes: catalog }), { reply: '真不错！', meme: '开心' });
  assert.equal(calls, 1);
  assert.equal(body.response_format.type, 'json_object');
  assert.match(body.messages[0].content, /笑脸，开心、庆祝/);
  assert.equal(body.max_tokens, 600);
  assert.deepEqual(await ask('好开心', [], undefined, [], { memes: catalog }), { reply: '真不错！', meme: null });
});

test('JSON 缺失文字、截断和畸形结果不会泄漏到群里', async () => {
  for (const [value, finish] of [['not-json', 'stop'], [{ meme: '开心' }, 'stop'], [{ reply: '回答', meme: '开心' }, 'length']]) {
    const ask = createDeepseek(config(), async () => response(value, finish));
    await assert.rejects(ask('你好', [], undefined, [], { memes: catalog }), /invalid_structured_reply/);
  }
});

function fixture(overrides = {}, dependencies = {}) {
  const actions = [];
  const asks = [];
  const logs = [];
  const c = config(overrides);
  const bot = createBot(c, {
    media: { catalog: () => catalog, meme: () => ({ image: { bytes: png, ext: 'png' } }) },
    ask: async (...args) => { asks.push(args); return { reply: '真不错！', meme: args[4]?.memes?.[0]?.name }; },
    qq: { send: async (...args) => actions.push(['text', ...args]),
      uploadImage: async (...args) => { actions.push(['upload', ...args]); return 'info'; },
      sendImage: async (...args) => actions.push(['image', ...args]) },
    now: Date.now, random: () => 0, log: (...args) => logs.push(args), ...dependencies
  });
  return { bot, actions, asks, logs };
}

test('先送达文字再按序号2发一张表情；下一轮只记实际文字，重复事件不再发图', async () => {
  const f = fixture();
  f.bot.submit(event('今天好开心', '1'));
  assert.equal(f.bot.submit(event('今天好开心', '1')).reason, 'duplicate');
  await f.bot.drain();
  assert.deepEqual(f.actions.map(item => item[0]), ['text', 'upload', 'image']);
  assert.deepEqual(f.actions[2].slice(1), ['g', '1', 'info', 2]);
  f.bot.submit(event('继续聊聊', '2'));
  await f.bot.drain();
  assert.deepEqual(f.asks[1][4], {});
  assert.equal(f.asks[1][1][1].content, '真不错！');
  assert.equal(f.actions.filter(item => item[0] === 'image').length, 1);
});

test('表情失败不影响已送达文字与记忆，也不补发错误文本', async () => {
  let asks = 0;
  let textSends = 0;
  let imageSends = 0;
  const histories = [];
  const f = fixture({}, {
    ask: async (prompt, history) => { asks++; histories.push(history); return { reply: '回答已完成', meme: '开心' }; },
    qq: { send: async () => { textSends++; }, uploadImage: async () => 'info',
      sendImage: async () => { imageSends++; throw new Error('ambiguous'); } }
  });
  f.bot.submit(event('开心', '1')); await f.bot.drain();
  assert.equal(textSends, 1); assert.equal(imageSends, 1);
  assert.equal(f.logs.at(-1)[1], 'auto_meme_failed');
  f.bot.submit(event('继续', '2')); await f.bot.drain();
  assert.equal(histories[1][1].content, '回答已完成');
  assert.equal(asks, 2); assert.equal(textSends, 2); assert.equal(imageSends, 1);
});

test('文字发送失败不发图，命令与非 @ 事件不触发自主选图', async () => {
  let uploads = 0;
  const f = fixture({}, { qq: { send: async () => { throw new Error('send failed'); }, uploadImage: async () => { uploads++; } } });
  f.bot.submit(event('开心', '1')); await f.bot.drain();
  f.bot.submit(event('/ping', '2')); await f.bot.drain();
  f.bot.submit(event('/help', '3')); await f.bot.drain();
  assert.equal(f.bot.submit({ ...event('开心', '4'), t: 'GROUP_MESSAGE_CREATE' }).kind, 'observed');
  assert.equal(uploads, 0); assert.equal(f.asks.length, 1);
});

test('模型选择 null 或库外名称时只有正常回答，不自动搜图或乱选替代图', async () => {
  for (const meme of [null, '不在库里']) {
    const f = fixture({}, { ask: async () => ({ reply: '正常回答', meme }) });
    f.bot.submit(event('你好', '1')); await f.bot.drain();
    assert.deepEqual(f.actions.map(item => item[0]), ['text']);
    assert.equal(f.actions[0][3], '正常回答');
  }
});

test('表情描述请求仅看当前表情，输出为短描述并校验结构', async () => {
  let body;
  const describe = createMemeDescriber(config(), async (url, init) => {
    body = JSON.parse(init.body); return response({ description: '笑脸，适合开心和庆祝。' });
  });
  assert.equal(await describe({ dataUrl: 'data:image/png;base64,test' }), '笑脸，适合开心和庆祝。');
  assert.equal(body.max_tokens, 200);
  assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.equal(body.messages.length, 2);
  await assert.rejects(createMemeDescriber(config(), async () => response({ description: '' }))({ dataUrl: 'test' }), /invalid_description/);
});

function cleanup(directory) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'fatfish-reactions-'));
  rmSync(directory, { recursive: true, force: true });
}

test('保存表情只标注一次，描述持久化；标注失败仍保留可调用图片', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fatfish-reactions-'));
  try {
    let descriptions = 0;
    const c = config({ memeDataDir: directory });
    const media = createMedia(c, { download: async () => png,
      describe: async () => { descriptions++; return '开心，适合祝贺。'; } });
    const message = { author: { member_role: 'admin' }, attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png' }] };
    await media.save('g', '大肥鱼', message);
    assert.equal(descriptions, 1);
    assert.equal(createMedia(c).catalog('g')[0].description, '开心，适合祝贺。');
    assert.deepEqual(media.catalog('other'), []);
    const failed = createMedia(c, { download: async () => png, describe: async () => { throw new Error('network'); } });
    await failed.save('g', '疑惑', message);
    assert.ok(failed.meme('g', '疑惑').image.bytes.length);
    assert.equal(failed.catalog('g').find(item => item.name === '疑惑').description, '疑惑');
  } finally { cleanup(directory); }
});

test('模型标注期间图片被替换时，不能把旧描述写到新图上', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fatfish-reactions-'));
  try {
    const c = config({ memeDataDir: directory });
    await createMedia(c, { download: async () => png }).save('g', '大肥鱼', {
      author: { member_role: 'owner' }, attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png' }]
    });
    let finish;
    const media = createMedia(c, { describe: () => new Promise(resolveDescription => { finish = resolveDescription; }) });
    const pending = media.annotate('g', '大肥鱼');
    const groupFolder = join(directory, readdirSync(directory)[0]);
    writeFileSync(join(groupFolder, '大肥鱼.png'), Buffer.concat([png, Buffer.from('new')]));
    finish('旧图片的描述');
    assert.equal(await pending, false);
    assert.equal(media.catalog('g')[0].description, '大肥鱼');
  } finally { cleanup(directory); }
});

test('QQ 自动表情的消息序号为2，手动表情仍默认为1', async () => {
  const bodies = [];
  const qq = createQQ(config(), async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('getAppAccessToken')) return json({ access_token: 'test-token', expires_in: 7200 });
    bodies.push(body); return json({ id: 'sent' });
  });
  await qq.sendImage('g', 'm1', 'info', 2);
  await qq.sendImage('g', 'm2', 'info');
  assert.deepEqual(bodies.map(body => body.msg_seq), [2, 1]);
});
