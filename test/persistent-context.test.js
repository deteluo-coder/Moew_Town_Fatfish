import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConversationStore } from '../src/context.js';
import { createSummarizer } from '../src/clients.js';
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';

function fixture(t, overrides = {}) {
  const root = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, 'qq-memory-test-'));
  t.after(() => {
    const target = fs.realpathSync(directory);
    if (!target.startsWith(root + path.sep) || !path.basename(target).startsWith('qq-memory-test-')) throw new Error('Unsafe cleanup target');
    fs.rmSync(target, { recursive: true, force: true });
  });
  const config = {
    appId: 'test-app', contextScope: 'group', contextPersist: true, contextDataDir: directory,
    contextTurns: 2, contextRecentTurns: 1, contextTtlMs: 0, contextMaxChars: 12000,
    contextMaxSessions: 2, contextCompact: true, contextSummaryMaxChars: 2000,
    contextCompactBatchChars: 24000, contextCompactRetryMs: 60000,
    contextPendingMaxChars: 120000, contextPendingMaxTurns: 200,
    maxInput: 2000, maxReply: 1200, ...overrides
  };
  return { config, directory };
}

test('成功问答重启后可恢复，不再因默认空闲时间而丢失', t => {
  const { config } = fixture(t);
  const first = createConversationStore(config, () => 1000);
  first.append('group-a', '我叫小鱼', '你好，小鱼', 'member_one');
  const restored = createConversationStore(config, () => 1000 + 365 * 86400000);
  assert.equal(restored.get('group-a')[0].content, '我叫小鱼');
  assert.equal(restored.get('group-a')[0].name, 'member_one');
  assert.deepEqual(restored.get('group-b'), []);
  const moduleUrl = new URL('../src/context.js', import.meta.url).href;
  const program = `import {createConversationStore} from ${JSON.stringify(moduleUrl)};const config=JSON.parse(process.argv[1]);console.log(createConversationStore(config).get('group-a')[0].content);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(config)], { encoding: 'utf8' }).trim(), '我叫小鱼');
});

test('写入中断时旧快照完整，新记录在内存保留并可重试保存', async t => {
  const { config } = fixture(t);
  let fail = false;
  const io = { ...fs, renameSync: (...args) => {
    if (fail) throw Object.assign(new Error('simulated disk failure'), { code: 'EACCES' });
    return fs.renameSync(...args);
  } };
  const store = createConversationStore(config, Date.now, { io });
  store.append('group-a', '第一条事实', '第一条回答');
  fail = true;
  assert.throws(() => store.append('group-a', '第二条事实', '第二条回答'), /write_failed/);
  assert.equal(store.stats('group-a').dirty, true);
  assert.equal(createConversationStore(config).get('group-a').length, 2);
  assert.equal(store.get('group-a').length, 4);
  fail = false;
  await store.prepare('group-a');
  assert.equal(createConversationStore(config).get('group-a').length, 4);
  assert.equal(store.stats('group-a').dirty, false);
});

test('摘要写盘失败不会替换原话或增加压缩次数', async t => {
  const { config } = fixture(t);
  let fail = false;
  const io = { ...fs, renameSync: (...args) => {
    if (fail) throw new Error('simulated rename failure');
    return fs.renameSync(...args);
  } };
  const store = createConversationStore(config, Date.now, { io });
  for (let i = 1; i <= 3; i++) store.append('group-a', `原话${i}`, `答案${i}`);
  fail = true;
  await store.prepare('group-a', async () => '候选摘要');
  assert.equal(store.stats('group-a').compactions, 0);
  const restored = createConversationStore(config);
  let oldest;
  await restored.prepare('group-a', async data => { oldest = data.messages[0].content; return '新摘要'; });
  assert.equal(oldest, '原话1');
});

test('清空与异步摘要同时发生时，旧摘要不能恢复已清除的内容', async t => {
  const { config } = fixture(t);
  const store = createConversationStore(config);
  for (let i = 1; i <= 3; i++) store.append('group-a', `旧话${i}`, `旧答${i}`);
  let finish;
  const pending = store.prepare('group-a', () => new Promise(resolve => { finish = resolve; }));
  store.clear('group-a');
  finish('旧记录的摘要');
  await pending;
  assert.deepEqual(store.get('group-a'), []);
  assert.deepEqual(createConversationStore(config).get('group-a'), []);
});

test('损坏快照报错并保留文件，不静默覆盖；明确清空后可重新使用', t => {
  const { config, directory } = fixture(t);
  const store = createConversationStore(config);
  store.append('group-a', '要保留的内容', '回答');
  const namespace = fs.readdirSync(directory)[0];
  const dataFile = fs.readdirSync(path.join(directory, namespace)).find(name => name !== 'identity.json' && name.endsWith('.json'));
  const file = path.join(directory, namespace, dataFile);
  fs.writeFileSync(file, '{broken-snapshot', 'utf8');
  const restored = createConversationStore(config);
  assert.throws(() => restored.get('group-a'), /snapshot_corrupt/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken-snapshot');
  restored.clear('group-a');
  assert.deepEqual(createConversationStore(config).get('group-a'), []);
});

test('不同机器人和上下文模式使用独立存储空间', t => {
  const { config } = fixture(t);
  createConversationStore(config).append('same-key', '仅属于机器人甲', '回答');
  assert.deepEqual(createConversationStore({ ...config, appId: 'another-app' }).get('same-key'), []);
  assert.deepEqual(createConversationStore({ ...config, contextScope: 'member' }).get('same-key'), []);
});

test('持续压缩失败达到积压上限时暂停新推理，旧数据仍可恢复', async t => {
  const { config } = fixture(t, { contextPendingMaxTurns: 3 });
  const store = createConversationStore(config);
  for (let i = 1; i <= 3; i++) store.append('group-a', `问题${i}`, `回答${i}`);
  await assert.rejects(store.prepare('group-a', async () => { throw new Error('offline'); }), /compaction_backlog_full/);
  const restored = createConversationStore(config);
  let oldest;
  await restored.prepare('group-a', async data => { oldest = data.messages[0].content; return '恢复后的摘要'; });
  assert.equal(oldest, '问题1');
});

test('摘要作为背景资料发送，输出窗口受文本预算约束', async t => {
  const { config } = fixture(t, { contextMaxChars: 200, contextSummaryMaxChars: 1000 });
  const store = createConversationStore(config);
  for (let i = 1; i <= 3; i++) store.append('group-a', `问题${i}`, `回答${i}`);
  await store.prepare('group-a', async () => '摘要'.repeat(200));
  const history = store.get('group-a');
  assert.ok(history.every(message => message.role !== 'system'));
  assert.ok(history.reduce((sum, message) => sum + Array.from(message.content).length, 0) <= 200);
});

test('摘要请求使用单独的摘要指令，并拒绝截断结果', async () => {
  const config = loadConfig({ QQ_APP_ID: 'test', QQ_APP_SECRET: 'test', DEEPSEEK_API_KEY: 'test' });
  let request;
  const summarize = createSummarizer(config, async (url, init) => {
    request = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '保留的关键信息' }, finish_reason: 'stop' }] }));
  });
  assert.equal(await summarize({ summary: '旧摘要', messages: [{ role: 'user', content: '新事实' }], maxChars: 200 }), '保留的关键信息');
  assert.equal(request.thinking.type, 'disabled');
  assert.match(request.messages[0].content, /不编造/);
  assert.equal(JSON.parse(request.messages[1].content).previous_summary, '旧摘要');
  const truncated = createSummarizer(config, async () => new Response(JSON.stringify({ choices: [{ message: { content: '不完整摘要' }, finish_reason: 'length' }] })));
  await assert.rejects(truncated({ summary: '', messages: [], maxChars: 200 }), /invalid_or_truncated_summary/);
});

test('机器人重启后沿用匿名身份与摘要，清空命令同时重置长期记录', async t => {
  const { config: storage } = fixture(t);
  const config = { ...loadConfig({}, { mock: true }), ...storage, cooldownMs: 0,
    groups: new Set(['group-a']), contextScope: 'group' };
  const calls = [];
  const replies = [];
  const makeBot = () => createBot(config, {
    ask: async (prompt, history, speaker) => { calls.push({ prompt, history, speaker }); return '测试答案'; },
    summarize: async data => { assert.match(data.messages[0].content, /蓝色橘子/); return '首位成员提供活动口令蓝色橘子。'; },
    qq: { send: async (group, id, content) => replies.push(content) }, log: () => {}
  });
  let sequence = 0;
  async function send(bot, content) {
    assert.equal(bot.submit({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
      id: 'persist-bot-' + ++sequence, group_openid: 'group-a', author: { member_openid: 'user-one' },
      content, timestamp: new Date().toISOString()
    } }).kind, 'accepted');
    await bot.drain();
  }
  const first = makeBot();
  await send(first, '活动口令蓝色橘子');
  await send(first, '第二问');
  await send(first, '第三问');
  const restarted = makeBot();
  await send(restarted, '重启后追问');
  assert.equal(calls[3].speaker, calls[0].speaker);
  assert.equal(calls[3].history[0].name, 'conversation_memory');
  assert.match(calls[3].history[0].content, /蓝色橘子/);
  await send(restarted, '/memory');
  assert.match(replies.at(-1), /已压缩 1 次/);
  await send(restarted, '清空记忆');
  const afterClear = makeBot();
  await send(afterClear, '清空后追问');
  assert.deepEqual(calls.at(-1).history, []);
});

test('自动摘要只替换较早的完整问答，保留最近原话并可重启恢复', async t => {
  const { config } = fixture(t);
  const store = createConversationStore(config);
  store.append('group-a', '活动口令是蓝色橘子472', '已记住', 'member_one');
  store.append('group-a', '活动下周开始', '好的', 'member_two');
  store.append('group-a', '最近一问', '最近一答', 'member_one');
  let received;
  await store.prepare('group-a', async data => {
    received = data;
    return '成员 member_one 提供活动口令蓝色橘子472；活动下周开始。';
  });
  assert.equal(received.messages.length, 4);
  const history = store.get('group-a');
  assert.equal(history[0].name, 'conversation_memory');
  assert.match(history[0].content, /蓝色橘子472/);
  assert.deepEqual(history.slice(-2).map(x => x.content), ['最近一问', '最近一答']);
  const restored = createConversationStore(config);
  assert.deepEqual(restored.get('group-a'), history);
  assert.equal(restored.stats('group-a').compactions, 1);
});

test('摘要 API 失败时保留原始记录，重启后仍可再次压缩', async t => {
  const { config } = fixture(t);
  const store = createConversationStore(config);
  for (let i = 1; i <= 3; i++) store.append('group-a', `问题${i}`, `回答${i}`);
  await store.prepare('group-a', async () => { throw new Error('temporary API failure'); });
  const restored = createConversationStore(config);
  let original;
  await restored.prepare('group-a', async data => { original = data; return '已经保存关键事实'; });
  assert.equal(original.messages[0].content, '问题1');
  assert.equal(restored.stats('group-a').compactions, 1);
});

test('清空记忆同时清除磁盘上的摘要和原话，其他群不受影响', async t => {
  const { config } = fixture(t);
  const store = createConversationStore(config);
  for (let i = 1; i <= 3; i++) store.append('group-a', `甲${i}`, `答${i}`);
  store.append('group-b', '乙的问题', '乙的答案');
  await store.prepare('group-a', async () => '甲的长期摘要');
  store.clear('group-a');
  const restored = createConversationStore(config);
  assert.deepEqual(restored.get('group-a'), []);
  assert.equal(restored.stats('group-a').summaryChars, 0);
  assert.equal(restored.get('group-b')[0].content, '乙的问题');
});

test('缓存淘汰只卸载内存，不删除长期记录；匿名标签密钥重启后保持一致', t => {
  const { config } = fixture(t, { contextMaxSessions: 1 });
  const store = createConversationStore(config);
  const alias = store.getAliasKey();
  store.append('group-a', '甲的问题', '甲的答案');
  store.append('group-b', '乙的问题', '乙的答案');
  assert.equal(store.get('group-a')[0].content, '甲的问题');
  const restored = createConversationStore(config);
  assert.deepEqual(restored.getAliasKey(), alias);
});
