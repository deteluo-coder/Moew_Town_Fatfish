import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createDeepseek } from '../src/clients.js';
import { createBot } from '../src/bot.js';
import { createLogger } from '../src/log.js';

const c = { ...loadConfig({ QQ_APP_ID: 'test', QQ_APP_SECRET: 'secret', DEEPSEEK_API_KEY: 'test-key' }),
  contextPersist: false, contextCompact: false, autoMemeEnabled: false, cooldownMs: 0, groups: new Set(['g']) };
const response = (content, finish_reason = 'stop', extra = {}) => new Response(JSON.stringify({
  choices: [{ message: { content, ...extra }, finish_reason }], usage: { completion_tokens: 1 }
}));
const event = (id, content) => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id, content, group_openid: 'g', author: { member_openid: 'u' }, timestamp: new Date().toISOString()
} });

test('HTTP200 空正文只重试一次，恢复后返回正常回答并记录安全诊断', async () => {
  let calls = 0;
  const lines = [];
  const ask = createDeepseek(c, async () => ++calls === 1 ? response('') : response('恢复正常'), createLogger(line => lines.push(line)));
  assert.equal(await ask('测试'), '恢复正常');
  assert.equal(calls, 2);
  assert.ok(lines.some(line => line.includes('deepseek_empty_retry')));
  assert.ok(!lines.join('').includes('test-key') && !lines.join('').includes('恢复正常'));
});

test('表情JSON模式返回空内容时，第二次关闭JSON模式优先恢复文字回复', async () => {
  const bodies = [];
  const ask = createDeepseek(c, async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? response('') : response('普通文字已恢复');
  });
  assert.equal(await ask('测试', [], undefined, [], { memes: [{ name: '开心', description: '开心时使用' }] }), '普通文字已恢复');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].response_format.type, 'json_object');
  assert.equal(bodies[1].response_format, undefined);
  assert.ok(!bodies[1].messages[0].content.includes('本次回答使用 JSON 格式'));
  assert.equal(bodies[1].max_tokens, 600);
  assert.equal(bodies[1].thinking.type, 'disabled');
});

test('连续两次空回复就结束，不无限调用；保留停止原因和用量诊断', async () => {
  let calls = 0;
  const ask = createDeepseek(c, async () => { calls++; return response(''); });
  await assert.rejects(ask('测试'), error => error.reason === 'empty_reply' && error.finishReason === 'stop' && error.tokens === 1);
  assert.equal(calls, 2);
});

test('拒答、输出耗尽、工具调用和网络错误均不触发空回复重试', async () => {
  for (const [finish, extra] of [['content_filter', {}], ['stop', { refusal: 'refused' }],
    ['length', {}], ['tool_calls', { tool_calls: [{ id: 'tool1' }] }]]) {
    let calls = 0;
    const ask = createDeepseek(c, async () => { calls++; return response('', finish, extra); });
    await assert.rejects(ask('测试'), /empty_reply/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const ask = createDeepseek(c, async () => { calls++; throw new Error('network'); });
  await assert.rejects(ask('测试'), /network_or_invalid_response/);
  assert.equal(calls, 1);
});

test('空回复恢复不会重复发群消息或写入故障文字，后续历史只有有效回答', async () => {
  let calls = 0;
  const bodies = [];
  const replies = [];
  const ask = createDeepseek(c, async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return ++calls === 1 ? response('') : response('有效回答');
  });
  const bot = createBot(c, { ask, log: () => {}, qq: { send: async (...args) => replies.push(args) } });
  bot.submit(event('1', '你好')); await bot.drain();
  assert.equal(replies.length, 1);
  assert.equal(replies[0][2], '有效回答');
  bot.submit(event('2', '继续')); await bot.drain();
  assert.equal(replies.length, 2);
  assert.equal(bodies[2].messages[2].content, '有效回答');
});
