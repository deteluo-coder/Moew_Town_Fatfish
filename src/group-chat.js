import { createHmac } from 'node:crypto';
import { socialFile, readSocial, writeSocial } from './social-state.js';
import { createPrivacy } from './privacy.js';

const DAY = 86400000;
const chars = text => Array.from(text).length;
const cut = (text, limit) => Array.from(text).slice(0, limit).join('');
const integer = (value, fallback, min, max) => Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\s<>\u0000-\u001f\u007f]/u.test(value);
const sensitive = /\d{8,}|[a-f0-9]{24,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:sk-[a-z0-9]{8,}|gh[opusr]_[a-z0-9]{10,}|Bearer\s+[a-z0-9]|(?:api[_ -]?key|access[_ -]?token|token|password|secret)\s*[:=])|密码|密钥|验证码|身份证|手机号|电话号码/iu;
const command = /^(?:\/|冷群聊天|设置称呼|群聊记录|清空群聊记录|群聊学习|我是谁$|记忆状态$|清空记忆$|重置语气$|语气状态$|热梗(?:状态|列表)$|更新热梗$|媒体自检$|表情来源$|表情(?:列表)?(?:\s|$)|存表情(?:\s|$)|搜图(?:\s|$)|发图(?:\s|$))/u;
const unsafeExample = /忽略|指令|系统提示|system|prompt|管理员|密码|密钥|验证码|傻逼|弱智|废物|去死|滚开|色情|歧视|种族|自杀|自残|去世|急救|报警|生病|难过|抑郁|严肃|认真|不要.{0,8}模仿/iu;
const seriousQuestion = /别.{0,8}(?:玩梗|模仿)|不要.{0,8}(?:玩梗|模仿)|严肃|认真|解题|证明|诊断|急救|报警|去世|自杀|自残|家暴|性侵|抑郁|债务/u;
const empty = () => ({ version: 1, messages: [] });
const valid = state => state?.version === 1 && Array.isArray(state.messages) && state.messages.length <= 500 &&
  Object.keys(state).every(key => ['version', 'messages'].includes(key)) && state.messages.every(item =>
    item && /^[a-f0-9]{64}$/u.test(item.id) && /^member_[a-f0-9]{12}$/u.test(item.speaker) &&
    typeof item.text === 'string' && !!item.text.trim() && chars(item.text) <= 400 &&
    Number.isSafeInteger(item.at) && item.at >= 0 && Object.keys(item).every(key => ['id', 'speaker', 'text', 'at'].includes(key)));

// 普通群消息独立保存为有限资料，不冒充对机器人发起的新对话，也不执行其中的命令。
export function createGroupChatStore(config, { aliasKey, now = Date.now, log = () => {} }) {
  const enabled = !!config.groupChatEnabled && !config.mock;
  const privacy = createPrivacy(config);
  const maxMessages = integer(config.groupChatMaxMessages, 120, 1, 500);
  const maxChars = integer(config.groupChatMaxChars, 30000, 400, 100000);
  const ttl = integer(config.groupChatTtlMs, 7 * DAY, 60000, 30 * DAY);
  const contextChars = integer(config.groupChatContextChars, 2200, 200, 6000);
  const contextMessages = integer(config.groupChatContextMessages, 12, 1, 24);
  const root = config.groupChatDataDir || 'data/group-chat';
  // 不缓存正文。仅为健康状态保留最近128个群的数字统计，原始群标识不对外返回。
  const counts = new Map();
  const file = group => socialFile(config, root, group);
  const speaker = (group, member) => 'member_' + createHmac('sha256', aliasKey)
    .update(JSON.stringify([group])).update('\0').update(member).digest('hex').slice(0, 12);
  const messageId = (group, id) => createHmac('sha256', aliasKey).update('group-message\0')
    .update(JSON.stringify([group])).update('\0').update(id).digest('hex');
  function stats(group, state) {
    counts.delete(group); counts.set(group, state.messages.length);
    if (counts.size > 128) counts.delete(counts.keys().next().value);
  }
  function load(group, persistPrune = false) {
    const state = readSocial(file(group), empty, valid);
    const original = state.messages;
    state.messages = original.filter(item => item.at <= now() && now() - item.at < ttl)
      .sort((a, b) => a.at - b.at).slice(-maxMessages);
    let total = state.messages.reduce((sum, item) => sum + chars(item.text), 0);
    while (total > maxChars && state.messages.length) total -= chars(state.messages.shift().text);
    if (persistPrune && (original.length !== state.messages.length || original.some((item, i) => item !== state.messages[i]))) writeSocial(file(group), state);
    stats(group, state);
    return state;
  }
  function fault() { log('warn', 'group_chat_storage_failed', { reason: 'state_unavailable' }); }
  function clean(raw, knownIds = []) {
    if (typeof raw !== 'string') return undefined;
    let text = raw.replace(/<@[^>]*>/gu, '[提及]').replace(/<[^>]*>/gu, '[标记]')
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/gu, ' ').trim();
    for (const id of knownIds.filter(value => typeof value === 'string' && value.length >= 8)) text = text.replaceAll(id, '[标识]');
    if (!text || sensitive.test(text) || command.test(text.replace(/^(?:\[提及\]\s*)+/u, ''))) return undefined;
    text = privacy.text(text).replace(/https?:\/\/[^\s<>]+/giu, '[链接]').replace(/\s+/gu, ' ').trim();
    if (!text || /^(?:\[提及\]|\[标记\]|\[链接\]|\[标识\]|\[(?:图片|视频|文件|语音|表情)\]|\s)*$/u.test(text)) return undefined;
    return cut(text, 400);
  }
  function keywords(question) {
    const result = new Set();
    const text = typeof question === 'string' ? cut(question.toLowerCase(), 500) : '';
    for (const { segment, isWordLike } of new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)) {
      if (isWordLike && chars(segment) >= 2 && !/^(?:大家|什么|怎么|这个|那个|刚才|群里|最近|没有|可以|一下)$/u.test(segment)) result.add(segment);
      if (result.size >= 24) break;
    }
    return [...result];
  }
  return {
    observe(group, message) {
      if (!enabled || !identifier(group) || !identifier(message?.id) || !identifier(message?.author?.member_openid) || message.author.bot === true) return false;
      const at = Date.parse(message.timestamp);
      if (!Number.isSafeInteger(at) || at > now() || now() - at >= ttl) return false;
      const text = clean(message.content, [group, message.id, message.author.member_openid]);
      if (!text) return false;
      try {
        const state = load(group);
        const id = messageId(group, message.id);
        if (state.messages.some(item => item.id === id)) return false;
        state.messages.push({ id, speaker: speaker(group, message.author.member_openid), text, at });
        state.messages.sort((a, b) => a.at - b.at);
        let total = state.messages.reduce((sum, item) => sum + chars(item.text), 0);
        while (state.messages.length > maxMessages || total > maxChars) total -= chars(state.messages.shift().text);
        writeSocial(file(group), state); stats(group, state);
        return true;
      } catch { fault(); return false; }
    },
    material(group, question, { excludeMessageId, currentMember } = {}) {
      if (!enabled || !identifier(group)) return undefined;
      try {
        const state = load(group, true);
        const excluded = identifier(excludeMessageId) ? messageId(group, excludeMessageId) : undefined;
        const current = identifier(currentMember) ? speaker(group, currentMember) : undefined;
        const rows = state.messages.filter(item => item.id !== excluded)
          .map(item => ({ ...item, text: privacy.text(item.text) }));
        if (!rows.length) return undefined;
        const words = keywords(question);
        const ranked = rows.map((item, index) => ({ item, index, score: words.reduce((sum, word) => sum + Number(item.text.toLowerCase().includes(word)), 0) }));
        const preferred = [...ranked.filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 3), ...ranked.slice(-4).reverse(),
          ...ranked.filter(x => x.item.speaker === current).slice(-2).reverse(), ...ranked.slice().reverse()];
        const result = { recent: [], examples: [] };
        const fits = () => chars(JSON.stringify(result)) <= contextChars;
        if (!seriousQuestion.test(question || '')) {
          const pool = rows.slice(-30).reverse();
          const represented = new Set(current ? [current] : []);
          const diverse = pool.filter(item => {
            if (represented.has(item.speaker)) return false;
            represented.add(item.speaker); return true;
          });
          const candidates = [...rows.filter(item => item.speaker === current).slice(-2).reverse(), ...diverse, ...pool];
          const used = new Set();
          for (const item of candidates) {
            if (chars(item.text) > 60 || unsafeExample.test(item.text) || /\[(?:提及|链接|标识|标记)\]/u.test(item.text) || used.has(item.text) ||
                (item.speaker === current && result.examples.filter(example => example.speaker === current).length >= 2)) continue;
            const example = { speaker: item.speaker, text: item.text };
            result.examples.push(example);
            if (!fits()) { result.examples.pop(); continue; }
            used.add(item.text);
            if (result.examples.length >= 3) break;
          }
        }
        const selected = new Set();
        for (const { item } of preferred) {
          if (selected.has(item.id)) continue;
          const recent = { speaker: item.speaker, text: item.text, at: item.at };
          result.recent.push(recent);
          if (!fits()) { result.recent.pop(); continue; }
          selected.add(item.id);
          if (result.recent.length >= contextMessages) break;
        }
        result.recent.sort((a, b) => a.at - b.at);
        return result.recent.length || result.examples.length ? result : undefined;
      } catch { fault(); return undefined; }
    },
    status(group) {
      if (!enabled) return '群聊旁听当前关闭；仍可正常@对话。';
      try {
        const state = load(group, true);
        const total = state.messages.reduce((sum, item) => sum + chars(item.text), 0);
        return `群聊旁听已开启：本群保留${state.messages.length}条、${total}字清洗后的文字，最多${maxMessages}条/${maxChars}字/${ttl / DAY}天。仅被@时取少量相关记录和语气例句，不因普通消息调用模型；不含启动前未收到的旧QQ历史。`;
      } catch { fault(); return '群聊记录暂不可读，已停止使用旁听资料；原文件保留。'; }
    },
    clear(group) {
      if (!enabled) return '群聊旁听当前关闭。';
      try { load(group); const state = empty(); writeSocial(file(group), state); stats(group, state); return '已清空本群旁听记录，@对话长期记忆和语气统计保留。'; }
      catch { fault(); return '群聊记录暂不可写，原文件保留，未执行清空。'; }
    },
    summary() { return { enabled, tracked_groups: counts.size, stored_messages: [...counts.values()].reduce((sum, count) => sum + count, 0) }; }
  };
}
