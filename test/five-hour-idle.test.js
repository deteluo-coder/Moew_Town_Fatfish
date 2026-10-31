import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createIdlePolicy, IDLE_TOPICS } from '../src/idle.js';
import { socialFile, writeSocial } from '../src/social-state.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const FIVE_HOURS = 5 * HOUR;
function fixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fatfish-five-hour-idle-'));
  let time = Date.parse('2026-10-31T20:00:00+08:00');
  const config = { appId: 'force-idle-test', idleEnabled: true, mock: false, groups: new Set(['g']),
    idleDataDir: directory, idleForceAfterMs: FIVE_HOURS,
    idleQuietMs: HOUR, idleCheckMs: 15 * MINUTE, idleChancePercent: 0,
    idleCooldownMs: 48 * HOUR, idleDailyMax: 0, idleStartHour: 9, idleEndHour: 22, ...extra };
  return { directory, config, now: () => time, advance(ms) { time += ms; },
    walk(policy, milliseconds, callback = () => {}) {
      while (milliseconds > 0) {
        const step = Math.min(MINUTE, milliseconds);
        time += step; milliseconds -= step;
        policy.heartbeat(); callback();
      }
    },
    cleanup() {
      assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + 'fatfish-five-hour-idle-'));
      fs.rmSync(directory, { recursive: true, force: true });
    } };
}
const policy = f => createIdlePolicy(f.config, { now: f.now, random: () => 0.99 });
const oldState = now => ({ version: 1, paused: false, blocked: false, day: new Date(now + 8 * HOUR).toISOString().slice(0, 10),
  attempts: 100, lastAttempt: now, lastTopic: 0, deliveredAt: now, deliveredTopic: 0 });

test('旧模式的概率、时段和额度会挡住发言，五小时强制模式明确覆盖这些限制', () => {
  const old = fixture({ idleForceAfterMs: 0 });
  const forced = fixture();
  try {
    for (const f of [old, forced]) {
      writeSocial(socialFile(f.config, f.directory, 'g'), oldState(f.now()));
      const idle = policy(f); idle.activity('g', { full: true });
      f.walk(idle, FIVE_HOURS);
      const lease = idle.reserve('g');
      if (f === old) assert.equal(lease, undefined);
      else { assert.ok(lease); assert.ok(idle.canSend(lease)); }
    }
  } finally { old.cleanup(); forced.cleanup(); }
});

test('连续观察4小时59分不能发，第5小时的tick必须产生一条，同一冷场只一次', () => {
  const f = fixture();
  try {
    const idle = policy(f); idle.activity('g', { full: true });
    f.walk(idle, FIVE_HOURS - MINUTE, () => assert.equal(idle.reserve('g'), undefined));
    f.walk(idle, MINUTE); const lease = idle.reserve('g');
    assert.ok(lease); assert.ok(IDLE_TOPICS.includes(lease.text)); assert.ok(idle.canSend(lease));
    idle.finish(lease, 'sent'); assert.equal(idle.context('g'), lease.text);
    f.walk(idle, 12 * HOUR, () => assert.equal(idle.reserve('g'), undefined));
    idle.activity('g', { full: true }); assert.equal(idle.reserve('g'), undefined);
    f.walk(idle, FIVE_HOURS - 1); assert.equal(idle.reserve('g'), undefined);
    f.walk(idle, 1); const next = idle.reserve('g');
    assert.ok(next); assert.notEqual(next.topic, lease.topic);
  } finally { f.cleanup(); }
});

test('只收到@不能认定群冷；全量确认较晚时从确认之后重新观察五小时', () => {
  const f = fixture();
  try {
    const idle = policy(f); idle.activity('g');
    f.walk(idle, 6 * HOUR); assert.equal(idle.reserve('g'), undefined);
    idle.confirmFull('g'); assert.equal(idle.reserve('g'), undefined);
    f.walk(idle, FIVE_HOURS - 1); assert.equal(idle.reserve('g'), undefined);
    f.walk(idle, 1); assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});

test('只读平台确认全量即可从0条消息开始观察五小时，旧模式仍需真人消息', () => {
  for (const forced of [true, false]) {
    const f = fixture({ idleForceAfterMs: forced ? FIVE_HOURS : 0, idleChancePercent: 100,
      idleDailyMax: 3, idleCooldownMs: 0, idleStartHour: 0, idleEndHour: 24 });
    try {
      const idle = policy(f); idle.confirmFull('g');
      f.walk(idle, FIVE_HOURS - 1); assert.equal(idle.reserve('g'), undefined);
      f.walk(idle, 1); const lease = idle.reserve('g');
      if (forced) { assert.ok(lease); assert.ok(idle.canSend(lease)); }
      else assert.equal(lease, undefined);
    } finally { f.cleanup(); }
  }
});

test('失联取消待发送话题；全量恢复后不能把失联期间计入五小时', () => {
  const f = fixture();
  try {
    const idle = policy(f); idle.activity('g', { full: true });
    f.walk(idle, FIVE_HOURS); const lease = idle.reserve('g'); assert.ok(lease);
    idle.disconnect(); assert.equal(idle.canSend(lease), false);
    f.walk(idle, 8 * HOUR); assert.equal(idle.reserve('g'), undefined);
    idle.confirmFull('g'); f.walk(idle, FIVE_HOURS);
    assert.equal(idle.reserve('g'), undefined, '未有新真人消息，不重复同一冷场已预留的话题');
    idle.activity('g', { full: true }); f.walk(idle, FIVE_HOURS);
    assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});

test('未发过话题的断线恢复，从重获全量流的时刻重新计满五小时', () => {
  const f = fixture();
  try {
    const idle = policy(f); idle.activity('g', { full: true }); f.walk(idle, 4 * HOUR);
    idle.disconnect(); f.walk(idle, 2 * HOUR); idle.confirmFull('g');
    f.walk(idle, HOUR); assert.equal(idle.reserve('g'), undefined);
    f.walk(idle, 4 * HOUR); assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});

test('休眠及向前/向后时钟跳变会取消观察和待发送凭据，不能偷算离线时间', () => {
  for (const gap of [4 * MINUTE, 8 * HOUR, -HOUR]) {
    const f = fixture();
    try {
      const idle = policy(f); idle.activity('g', { full: true }); f.walk(idle, FIVE_HOURS);
      const lease = idle.reserve('g'); assert.ok(lease);
      f.advance(gap); idle.heartbeat();
      assert.equal(idle.canSend(lease), false); assert.equal(idle.summary().groups_with_full_feed, 0);
      idle.activity('g', { full: true }); f.walk(idle, FIVE_HOURS - 1); assert.equal(idle.reserve('g'), undefined);
      f.walk(idle, 1); assert.ok(idle.reserve('g'));
    } finally { f.cleanup(); }
  }
});

test('发送前即便尚未来得及tick，长时间暂停或时钟回拨也不能发送旧话题', () => {
  for (const gap of [4 * MINUTE, -MINUTE]) {
    const f = fixture();
    try {
      const idle = policy(f); idle.activity('g', { full: true }); f.walk(idle, FIVE_HOURS);
      const lease = idle.reserve('g'); assert.ok(lease); f.advance(gap);
      assert.equal(idle.canSend(lease), false);
    } finally { f.cleanup(); }
  }
});

test('管理员暂停和发送失败仍优先；普通成员不能打开，恢复后仍等待新的真人冷场', () => {
  const f = fixture();
  try {
    const idle = policy(f); idle.activity('g', { full: true });
    idle.command('g', '关', 'owner'); f.walk(idle, FIVE_HOURS);
    assert.equal(idle.reserve('g'), undefined); assert.match(idle.status('g'), /管理员已暂停/);
    assert.match(idle.command('g', '开', 'member'), /仅限/);
    idle.command('g', '开', 'admin'); idle.activity('g'); f.walk(idle, FIVE_HOURS);
    const lease = idle.reserve('g'); assert.ok(lease); idle.finish(lease, 'failed');
    idle.activity('g'); f.walk(idle, FIVE_HOURS); assert.equal(idle.reserve('g'), undefined);
    assert.match(idle.status('g'), /发送失败/);
    idle.command('g', '开', 'admin'); idle.activity('g'); f.walk(idle, FIVE_HOURS);
    assert.ok(idle.reserve('g'));
  } finally { f.cleanup(); }
});

test('损坏额度存储保持原样并停发；旧version1持久状态兼容，重启重新完整观察', () => {
  const f = fixture();
  try {
    const file = socialFile(f.config, f.directory, 'g');
    writeSocial(file, oldState(f.now()));
    let idle = policy(f); idle.activity('g', { full: true }); f.walk(idle, 4 * HOUR);
    idle = policy(f); f.walk(idle, FIVE_HOURS); assert.equal(idle.reserve('g'), undefined);
    idle.activity('g', { full: true }); f.walk(idle, FIVE_HOURS - 1); assert.equal(idle.reserve('g'), undefined);
    f.walk(idle, 1); assert.ok(idle.reserve('g'));
    fs.writeFileSync(file, 'damaged'); idle.activity('g'); f.walk(idle, FIVE_HOURS);
    assert.equal(idle.reserve('g'), undefined); assert.match(idle.status('g'), /存储暂不可读/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
  } finally { f.cleanup(); }
});

test('健康摘要说明五小时截止时刻且不含群ID或消息；已预留、暂停、不完整观察不伪造下一次时间', () => {
  const f = fixture({ groups: new Set(['private-group-identity']) });
  try {
    const group = 'private-group-identity'; const idle = policy(f);
    assert.equal(idle.summary().force_after_minutes, 300);
    assert.equal(idle.summary().waiting_groups, 1); assert.equal(idle.summary().next_due_at, null);
    idle.activity(group, { full: true });
    assert.equal(idle.summary().next_due_at, new Date(f.now() + FIVE_HOURS).toISOString());
    assert.ok(!JSON.stringify(idle.summary()).includes(group));
    assert.match(idle.status(group), /5小时/); assert.match(idle.status(group), /全天/);
    f.walk(idle, FIVE_HOURS); const lease = idle.reserve(group); assert.ok(lease);
    assert.equal(idle.summary().next_due_at, null);
    idle.activity(group); idle.command(group, '关', 'owner'); assert.equal(idle.summary().next_due_at, null);
    idle.disconnect(); assert.equal(idle.summary().groups_with_full_feed, 0);
  } finally { f.cleanup(); }
});

test('强制模式仍只对白名单群工作，mock或关闭不触发', () => {
  for (const extra of [{}, { mock: true }, { idleEnabled: false }]) {
    const f = fixture(extra);
    try {
      const idle = policy(f); idle.activity('unlisted', { full: true }); f.walk(idle, FIVE_HOURS);
      assert.equal(idle.reserve('unlisted'), undefined);
      if (extra.mock || extra.idleEnabled === false) {
        idle.activity('g', { full: true }); f.walk(idle, FIVE_HOURS); assert.equal(idle.reserve('g'), undefined);
      }
    } finally { f.cleanup(); }
  }
});
