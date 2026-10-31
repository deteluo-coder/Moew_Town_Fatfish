import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { createDeepseek } from '../src/clients.js';

function fixture(overrides = {}, dependencies = {}) {
  const calls = [];
  const replies = [];
  const logs = [];
  const config = {
    ...loadConfig({}, { mock: true }), cooldownMs: 0, contextScope: 'member',
    contextTurns: 10, contextTtlMs: 1800000, contextMaxChars: 12000, contextMaxSessions: 500,
    ...overrides
  };
  const bot = createBot(config, {
    ask: async (prompt, history = [], speaker) => { calls.push({ prompt, history, speaker }); return '回答：' + prompt; },
    qq: { send: async (...args) => replies.push(args) }, log: (...args) => logs.push(args),
    ...dependencies
  });
  let sequence = 0;
  function event(content, group = 'demo-group', member = 'user-1') {
    return { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
      id: `context-${++sequence}`, group_openid: group, author: { member_openid: member },
      content, timestamp: new Date().toISOString()
    } };
  }
  async function send(content, group, member) {
    const result = bot.submit(event(content, group, member));
    await bot.drain();
    return result;
  }
  return { bot, event, send, calls, replies, logs };
}

test('连续追问会带上同一成员上一轮的提问与已发送答案', async () => {
  const f = fixture();
  await f.send('我叫小鱼');
  await f.send('我叫什么？');
  assert.deepEqual(f.calls[1].history, [
    { role: 'user', content: '我叫小鱼' },
    { role: 'assistant', content: '回答：我叫小鱼' }
  ]);
});

test('同群不同成员和同成员不同群的记忆相互隔离', async () => {
  const f = fixture({ allowAllGroups: true });
  await f.send('我的私人问题', 'demo-group', 'user-1');
  await f.send('我叫什么', 'demo-group', 'user-2');
  await f.send('我叫什么', 'other-group', 'user-1');
  assert.deepEqual(f.calls[1].history, []);
  assert.deepEqual(f.calls[2].history, []);
});

test('共享模式让同群成员承接前文，用匿名标签区分发言者，其他群保持隔离', async () => {
  const f = fixture({ contextScope: 'group', allowAllGroups: true });
  await f.send('我叫小鱼', 'demo-group', 'user-1');
  await f.send('刚才那位叫什么', 'demo-group', 'user-2');
  assert.equal(f.calls[1].history[0].content, '我叫小鱼');
  assert.match(f.calls[0].speaker, /^member_[a-f0-9]{12}$/);
  assert.equal(f.calls[1].history[0].name, f.calls[0].speaker);
  assert.notEqual(f.calls[0].speaker, f.calls[1].speaker);
  assert.ok(!JSON.stringify(f.calls).includes('user-1'));
  await f.send('我们刚才说了什么', 'other-group', 'user-1');
  assert.deepEqual(f.calls[2].history, []);
  await f.send('清空记忆', 'demo-group', 'user-2');
  await f.send('还记得吗', 'demo-group', 'user-1');
  assert.deepEqual(f.calls[3].history, []);
});

test('清空记忆只清除当前会话，并且不调用 AI', async () => {
  const f = fixture();
  await f.send('请记住小鱼');
  await f.send('请记住小猫', 'demo-group', 'user-2');
  await f.send('清空记忆');
  assert.equal(f.calls.length, 2);
  assert.match(f.replies.at(-1)[2], /已清空/);
  await f.send('我是谁');
  assert.deepEqual(f.calls[2].history, []);
  await f.send('我是谁', 'demo-group', 'user-2');
  assert.equal(f.calls[3].history[0].content, '请记住小猫');
});

test('/ping、帮助和重置指令不会混入对话历史', async () => {
  const f = fixture();
  await f.send('第一问');
  await f.send('/ping');
  await f.send('/help');
  await f.send('第二问');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].history.length, 2);
  await f.send('/reset');
  assert.equal(f.calls.length, 2);
});

test('只保留完整的最近轮次，过期后下一问不带旧历史', async () => {
  let time = Date.now();
  const f = fixture({ contextTurns: 1, contextTtlMs: 100 }, { now: () => time });
  await f.send('第一问');
  await f.send('第二问');
  await f.send('第三问');
  assert.equal(f.calls[2].history[0].content, '第二问');
  time += 101;
  await f.send('过期后的提问');
  assert.deepEqual(f.calls[3].history, []);
});

test('同一会话不能并行生成，等待前一条完成后重试会带上历史', async () => {
  let finish;
  const histories = [];
  const f = fixture({}, { ask: (prompt, history = []) => {
    histories.push(history);
    return new Promise(resolve => { finish = resolve; });
  } });
  const first = f.event('第一问');
  const second = f.event('第二问');
  assert.equal(f.bot.submit(first).kind, 'accepted');
  assert.equal(f.bot.submit(second).kind, 'busy');
  await Promise.resolve();
  finish('第一答');
  await f.bot.drain();
  assert.equal(f.bot.submit(second).kind, 'accepted');
  await Promise.resolve();
  assert.equal(histories[1][1].content, '第一答');
  finish('第二答');
  await f.bot.drain();
});

test('未成功发送的回答和 AI 故障提示不写入历史', async () => {
  let failSend = true;
  const f = fixture({}, { qq: { send: async () => { if (failSend) throw new Error('send failed'); } } });
  await f.send('第一问');
  failSend = false;
  await f.send('第二问');
  assert.deepEqual(f.calls[1].history, []);
  let failAi = true;
  const histories = [];
  const ai = fixture({}, { ask: async (prompt, history = []) => {
    histories.push(history);
    if (failAi) throw new Error('AI failed');
    return '正常回答';
  } });
  await ai.send('失败提问');
  failAi = false;
  await ai.send('新的提问');
  assert.deepEqual(histories[1], []);
});

test('记忆预算和会话数量都有上限，可以关闭上下文', async () => {
  const bounded = fixture({ contextMaxChars: 8 });
  await bounded.send('这段话超过记忆预算');
  await bounded.send('下一问');
  assert.deepEqual(bounded.calls[1].history, []);
  const capped = fixture({ contextMaxSessions: 1 });
  await capped.send('甲的问题', 'demo-group', 'user-1');
  await capped.send('乙的问题', 'demo-group', 'user-2');
  await capped.send('甲的下一问', 'demo-group', 'user-1');
  assert.deepEqual(capped.calls[2].history, []);
  const disabled = fixture({ contextTurns: 0 });
  await disabled.send('第一问');
  await disabled.send('第二问');
  assert.deepEqual(disabled.calls[1].history, []);
});

test('DeepSeek 收到的顺序是系统提示、历史问答、当前问题', async () => {
  let messages;
  const ask = createDeepseek(loadConfig({ QQ_APP_ID: 'test', QQ_APP_SECRET: 'test', DEEPSEEK_API_KEY: 'test' }), async (url, init) => {
    messages = JSON.parse(init.body).messages;
    return new Response(JSON.stringify({ choices: [{ message: { content: '记得' } }] }));
  });
  const history = [{ role: 'user', content: '我叫小鱼' }, { role: 'assistant', content: '你好，小鱼' }];
  await ask('我叫什么', history, 'member_test');
  assert.deepEqual(messages.slice(1), [...history, { role: 'user', content: '我叫什么', name: 'member_test' }]);
  assert.equal(messages[0].role, 'system');
});

test('上下文保存实际送达的截断答案，日志不包含历史正文', async () => {
  const histories = [];
  const f = fixture({ maxReply: 100 }, { ask: async (prompt, history) => {
    histories.push(history);
    return '答'.repeat(200);
  } });
  await f.send('不能进入日志的测试正文');
  await f.send('继续');
  assert.equal(histories[1][1].content, f.replies[0][2]);
  assert.ok(Array.from(histories[1][1].content).length <= 100);
  assert.ok(!JSON.stringify(f.logs).includes('不能进入日志的测试正文'));
});

test('群共享模式下不同成员也按同一个会话顺序处理', async () => {
  let finish;
  const f = fixture({ contextScope: 'group' }, { ask: () => new Promise(resolve => { finish = resolve; }) });
  f.bot.submit(f.event('第一问', 'demo-group', 'user-1'));
  assert.equal(f.bot.submit(f.event('第二问', 'demo-group', 'user-2')).kind, 'busy');
  await Promise.resolve();
  finish('回答');
  await f.bot.drain();
});
