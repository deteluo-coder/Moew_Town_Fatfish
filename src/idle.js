import { socialFile, readSocial, writeSocial } from './social-state.js';

export const IDLE_TOPICS = [
  '绷，群聊怎么静成加载界面了🐟 最近谁刷到离谱视频？丢一个让鱼鉴赏鉴赏。',
  '喵喵镇今天有点缺德但合法的脑洞：给校园生活装一个模组，你第一件事改什么？🐟',
  '突击查岗👀 现在的精神状态，用一句台词或者一个表情包交代一下。',
  '鱼有个不成熟的想法🎨 给大肥鱼整套新皮肤，镇民们会把鱼打扮成什么抽象东西？',
  '突然好奇🐟 选一个动漫里的技能带到现实，大家会挑哪个？',
  '丢个轻松话题🍿 看番的时候，大家更爱一口气补完，还是每周追更新？',
  '小鱼探头✨ 有没有一部作品，你第一次看和后来重看时感受完全不一样？',
  '来交换点安利呀📚 除了动画，最近有没有喜欢的漫画或者游戏？',
  '想听听大家的脑洞🐾 如果喵喵镇办一次小活动，最想玩什么？',
  '鱼鱼路过🐟 哪个动漫角色的名台词，大家已经顺口说成口头禅了？',
  '随机话题掉落🎵 有没有一段动画配乐，一听就能想到那一幕？',
  '来点快乐的回忆✨ 最初让大家入坑二次元的作品是什么？',
  '绷，群聊进入省电模式了🐟 今天谁刷到最离谱但好笑的视频？扔个BV号让鱼开开眼。',
  '大肥鱼随机查岗👀 现在的精神状态用一个表情包形容，能有多抽象？',
  '喵喵镇支线任务：假如校园生活能装一个模组，最想加什么功能？🐟',
  '鱼有一个大胆提案：把今天的快乐小事捞一条上来，大小都算🐾',
  '最近B站首页都给大家推什么了？鱼怀疑每个人住的是不同的互联网🐟',
  '西校区的宝，丢掉标准答案：如果给喵喵镇整一次社团小活动，想玩什么？🎲',
  '严肃提问三秒钟：给晚自习写个游戏成就名，你会起什么离谱名字？🎮',
  '新闻以外也能整点活：有没有什么科技产品，是你看完直呼“这都行”？👀'
];
const initial = () => ({ version: 1, paused: false, blocked: false, day: '', attempts: 0, lastAttempt: 0, lastTopic: -1, deliveredAt: 0, deliveredTopic: -1 });
const valid = s => s?.version === 1 && typeof s.paused === 'boolean' && typeof s.blocked === 'boolean' &&
  /^(?:|\d{4}-\d{2}-\d{2})$/.test(s.day) && ['attempts', 'lastAttempt', 'deliveredAt'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0) &&
  ['lastTopic', 'deliveredTopic'].every(k => Number.isSafeInteger(s[k]) && s[k] >= -1 && s[k] < IDLE_TOPICS.length) &&
  (s.deliveredText === undefined || (typeof s.deliveredText === 'string' && Array.from(s.deliveredText).length <= 2000));
const beijing = time => new Date(time + 8 * 3600000);

export function createIdlePolicy(config, { now = Date.now, random = Math.random, log = () => {} } = {}) {
  const startedAt = now();
  const forceAfterMs = Number.isSafeInteger(config.idleForceAfterMs) && config.idleForceAfterMs > 0 ? config.idleForceAfterMs : 0;
  const runtime = new Map();
  let previousTick = now();
  const allowed = group => !!config.idleEnabled && !config.mock && config.groups.has(group);
  const file = group => socialFile(config, config.idleDataDir, group);
  const read = group => readSocial(file(group), initial, valid);
  function local(group) {
    if (!runtime.has(group)) runtime.set(group, { fullSeen: false, observedSince: null, observation: 0,
      lastHumanAt: 0, revision: 0, attemptedRevision: -1, nextCheckAt: 0 });
    return runtime.get(group);
  }
  function loseObservation() {
    for (const rt of runtime.values()) {
      rt.fullSeen = false; rt.observedSince = null; rt.lastHumanAt = 0; rt.observation++;
      // 失联不是新的真人发言，不清除本次冷场已经预留/发送的标记。
    }
  }
  function guardClock() {
    const timestamp = now();
    if (timestamp - previousTick > 180000 || timestamp < previousTick) {
      loseObservation(); previousTick = timestamp;
      return false;
    }
    return true;
  }
  function confirm(rt) {
    if (!rt.fullSeen) {
      rt.fullSeen = true; rt.observedSince = now(); rt.observation++;
      log('info', 'idle_full_feed_seen');
    }
  }
  const forceDueAt = rt => rt.fullSeen && rt.observedSince !== null
    ? Math.max(rt.observedSince, rt.lastHumanAt) + forceAfterMs : undefined;
  function fault() { log('warn', 'idle_storage_failed', { reason: 'state_unavailable' }); }
  return {
    disconnect() { loseObservation(); },
    confirmFull(group) {
      if (!allowed(group)) return;
      if (forceAfterMs) guardClock();
      const rt = local(group);
      confirm(rt);
    },
    activity(group, { full = false } = {}) {
      if (!allowed(group)) return;
      if (forceAfterMs) guardClock();
      const rt = local(group);
      rt.lastHumanAt = now(); rt.revision++;
      if (full) confirm(rt);
    },
    heartbeat() {
      // 休眠或长时间停顿后，不把收不到消息的时段认作群冷。
      guardClock();
      previousTick = now();
    },
    reserve(group) {
      if (!allowed(group)) return;
      if (forceAfterMs && !guardClock()) return;
      const rt = local(group);
      const timestamp = now();
      if (!rt.fullSeen || rt.attemptedRevision === rt.revision) return;
      if (forceAfterMs) {
        if (timestamp < forceDueAt(rt)) return;
      } else if (!rt.lastHumanAt || timestamp - startedAt < config.idleQuietMs || timestamp - rt.lastHumanAt < config.idleQuietMs || timestamp < rt.nextCheckAt) return;
      const date = beijing(timestamp);
      const hour = date.getUTCHours();
      if (!forceAfterMs && (hour < config.idleStartHour || hour >= config.idleEndHour)) return;
      try {
        const state = read(group);
        const day = date.toISOString().slice(0, 10);
        if (state.paused || state.blocked) return;
        if (!forceAfterMs) {
          if (timestamp - state.lastAttempt < config.idleCooldownMs || (state.day === day && state.attempts >= config.idleDailyMax)) return;
          rt.nextCheckAt = timestamp + config.idleCheckMs;
          if (random() * 100 >= config.idleChancePercent) return;
        }
        const topics = IDLE_TOPICS.map((text, topic) => ({ text, topic })).filter(item => item.topic !== state.lastTopic);
        const selected = topics[Math.min(topics.length - 1, Math.max(0, Math.floor(random() * topics.length)))];
        // 先落盘占用额度，再尝试发出；进程中断和结果不明也不补发。
        state.attempts = (state.day === day ? state.attempts : 0) + 1;
        state.day = day;
        state.lastAttempt = timestamp; state.lastTopic = selected.topic;
        writeSocial(file(group), state);
        rt.attemptedRevision = rt.revision;
        return { group, ...selected, revision: rt.revision, ...(forceAfterMs ? { observation: rt.observation } : {}) };
      } catch { fault(); }
    },
    canSend(lease) {
      if (!allowed(lease.group)) return false;
      if (forceAfterMs && !guardClock()) return false;
      const rt = local(lease.group);
      if (!rt.fullSeen || rt.revision !== lease.revision) return false;
      if (forceAfterMs) {
        if (lease.observation !== rt.observation || now() < forceDueAt(rt)) return false;
      } else if (now() - rt.lastHumanAt < config.idleQuietMs) return false;
      const hour = beijing(now()).getUTCHours();
      if (!forceAfterMs && (hour < config.idleStartHour || hour >= config.idleEndHour)) return false;
      try { const state = read(lease.group); return !state.paused && !state.blocked; } catch { fault(); return false; }
    },
    finish(lease, outcome) {
      try {
        const state = read(lease.group);
        if (outcome === 'sent') { state.deliveredAt = now(); state.deliveredTopic = lease.topic; state.deliveredText = Array.from(lease.text).slice(0, 2000).join(''); }
        else if (outcome === 'failed') state.blocked = true;
        writeSocial(file(lease.group), state);
      } catch { fault(); }
    },
    context(group) {
      if (!allowed(group)) return undefined;
      try {
        const state = read(group);
        return state.deliveredAt && now() - state.deliveredAt < 12 * 3600000 && state.deliveredTopic >= 0
          ? state.deliveredText || IDLE_TOPICS[state.deliveredTopic] : undefined;
      } catch { return undefined; }
    },
    command(group, argument, role) {
      if (!allowed(group)) return '本群未启用冷群聊天；需在本地配置中开启，并显式加入群白名单。';
      if (argument === '开' || argument === '关') {
        if (!['owner', 'admin'].includes(role)) return '冷群聊天开关仅限群主或管理员操作，身份以QQ事件提供的角色为准。';
        try {
          const state = read(group);
          state.paused = argument === '关';
          if (argument === '开') state.blocked = false;
          writeSocial(file(group), state);
          if (!forceAfterMs) local(group).nextCheckAt = now() + config.idleQuietMs;
        } catch { fault(); return '冷群聊天配置暂不可写，原文件会保留。'; }
      } else if (argument && argument !== '状态') return '用法：@大肥鱼 冷群聊天 状态／开／关（开关仅限管理员）。';
      return this.status(group);
    },
    status(group) {
      if (!allowed(group)) return '冷群聊天当前关闭。';
      try {
        if (forceAfterMs) guardClock();
        const state = read(group);
        const rt = local(group);
        const waiting = forceAfterMs ? '等待确认本次连接的全量消息流；平台需开启“接收所有消息”' : '等待本次连接收到普通群消息；请开启“接收所有消息”';
        const status = `冷群聊天：${state.paused ? '管理员已暂停' : state.blocked ? '上次发送失败，已暂停；管理员可发送“冷群聊天 开”重试' : !rt.fullSeen ? waiting : rt.attemptedRevision === rt.revision ? '本次冷场已尝试发言，等待新的真人消息' : '已确认全量消息流，正在观察群内活跃时间'}。`;
        const schedule = forceAfterMs
          ? `全天生效：在线且连续完整观察${forceAfterMs / 3600000}小时无人说话后，在下一次每分钟检查时抛一个话题，同一次冷场只说一次。管理员暂停或发送失败时停发；重启、断线、休眠后须重新确认消息流并观察${forceAfterMs / 3600000}小时。`
          : `北京时间${config.idleStartHour}～${config.idleEndHour}点，安静至少${config.idleQuietMs / 60000}分钟后每${config.idleCheckMs / 60000}分钟有${config.idleChancePercent}%机会发一条；两次至少间隔${config.idleCooldownMs / 3600000}小时，每天最多${config.idleDailyMax}条，同一次冷场只说一次。`;
        return status + schedule + (config.idleNewsEnabled ? `本地跨领域话题＋公开新闻缓存；四类轮换，每${config.idleNewsRefreshMs / 3600000}小时最多搜索一次，搜不到就聊日常，不另调聊天模型。` : '使用本地跨领域话题，不消耗DeepSeek token。');
      } catch { return '冷群聊天存储暂不可读，已停止主动发送，原文件会保留。'; }
    },
    summary() {
      if (forceAfterMs) guardClock();
      const base = { enabled: !!config.idleEnabled, groups_with_full_feed: [...runtime.values()].filter(rt => rt.fullSeen).length };
      if (!forceAfterMs) return base;
      let waiting = 0;
      const due = [];
      for (const group of config.groups) {
        if (!allowed(group)) continue;
        const rt = runtime.get(group);
        if (!rt?.fullSeen) { waiting++; continue; }
        if (rt.attemptedRevision === rt.revision) continue;
        try {
          const state = read(group);
          if (!state.paused && !state.blocked) due.push(forceDueAt(rt));
        } catch { /* 不可读的群不宣称有可执行的截止时刻。 */ }
      }
      return { ...base, force_after_minutes: forceAfterMs / 60000, waiting_groups: waiting,
        next_due_at: due.length ? new Date(Math.min(...due)).toISOString() : null };
    }
  };
}
