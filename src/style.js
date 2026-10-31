import { createHmac } from 'node:crypto';
import { socialFile, readSocial, writeSocial } from './social-state.js';

// 固定、无攻击性的词表：不保存原句，不让聊天指令混入底层提示。
const WORDS = ['哈哈', '好耶', '确实', '绷不住', '欸', '喵', '有一说一', '好家伙', '啊这', '懂了', '芜湖', '笑死', '好欸', '可恶', '咱就是说', '就是说', '狠狠', '可爱', '捏', '好诶', '哇', '诶', '呜呜', '嘿嘿', '好哒', '闹麻了', '绷不住了', '绷', '乐', '扎啤'];
const SENSITIVE = /https?:|```|\d{8,}|sk-[a-z\d]{8,}|密码|密钥|验证码|自杀|自残|轻生|去世|急救|报警|性侵|家暴/iu;
const profile = () => ({ samples: 0, short: 0, emoji: 0, words: {}, lastAt: 0 });
const empty = () => ({ version: 1, group: profile(), members: {} });
const validProfile = item => item && ['samples', 'short', 'emoji', 'lastAt'].every(key => Number.isSafeInteger(item[key]) && item[key] >= 0) &&
  item.samples <= 4096 && item.short <= item.samples && item.emoji <= item.samples && item.words &&
  Object.entries(item.words).every(([word, count]) => WORDS.includes(word) && Number.isSafeInteger(count) && count >= 0 && count <= 4096);
const valid = data => data?.version === 1 && validProfile(data.group) && data.members && !Array.isArray(data.members) &&
  Object.keys(data.members).length <= 500 && Object.entries(data.members).every(([id, p]) => /^member_[a-f0-9]{12}$/.test(id) && validProfile(p));

function learn(item, text, timestamp) {
  if (item.samples >= 128) {
    for (const key of ['samples', 'short', 'emoji']) item[key] = Math.floor(item[key] / 2);
    for (const key of Object.keys(item.words)) item.words[key] = Math.floor(item.words[key] / 2);
  }
  item.samples++;
  if (Array.from(text).length <= 40) item.short++;
  if (/\p{Extended_Pictographic}/u.test(text)) item.emoji++;
  // 长词优先；“绷不住了”不重复算“绷”，正常的“音乐/快乐”不算单字“乐”。
  let remaining = text;
  for (const word of [...WORDS].sort((a, b) => b.length - a.length)) {
    const single = word === '绷' || word === '乐';
    const pattern = single ? new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'gu') : undefined;
    if (single ? pattern.test(remaining) : remaining.includes(word)) {
      item.words[word] = (item.words[word] || 0) + 1;
      remaining = single ? remaining.replace(pattern, ' ') : remaining.replaceAll(word, ' ');
    }
  }
  item.lastAt = timestamp;
}
const top = (item, count) => Object.entries(item?.words || {}).filter(([, n]) => n >= 2)
  .sort((a, b) => b[1] - a[1]).slice(0, count).map(([word]) => word);

export function createStyleStore(config, { aliasKey, now = Date.now, log = () => {} }) {
  const file = group => socialFile(config, config.styleDataDir, group);
  const id = (group, member) => 'member_' + createHmac('sha256', aliasKey).update(JSON.stringify([group])).update('\0').update(member).digest('hex').slice(0, 12);
  function read(group) { return readSocial(file(group), empty, valid); }
  function guarded(action, fallback) {
    try { return action(); } catch { log('warn', 'style_storage_failed', { reason: 'state_unavailable' }); return fallback; }
  }
  return {
    observe(group, member, text) {
      if (!config.styleEnabled || typeof text !== 'string' || !text.trim() || Array.from(text).length > 160 || SENSITIVE.test(text) || /^\//.test(text)) return;
      guarded(() => {
        const state = read(group);
        const memberId = id(group, member);
        const current = state.members[memberId] || profile();
        // 每人每分钟最多贡献一次，避免刷屏把群体语气覆盖。
        if (current.samples && now() - current.lastAt < 60000) return;
        learn(current, text, now()); learn(state.group, text, now());
        state.members[memberId] = current;
        state.members = Object.fromEntries(Object.entries(state.members).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, 500));
        writeSocial(file(group), state);
      });
    },
    hint(group, member) {
      if (!config.styleEnabled) return undefined;
      return guarded(() => {
        const state = read(group);
        const groupWords = state.group.samples >= 6 ? top(state.group, 4) : [];
        const current = state.members[id(group, member)];
        const memberWords = current?.samples >= 3 ? top(current, 2) : [];
        return [groupWords.length ? `群内常用：${groupWords.join('、')}` : '先用通用轻松网络表达',
          memberWords.length ? `当前成员常用：${memberWords.join('、')}` : '',
          state.group.samples >= 6 && state.group.short / state.group.samples >= 0.65 ? '偏短句' : ''].filter(Boolean).join('；').slice(0, 140);
      }, '先用通用轻松网络表达');
    },
    status(group) {
      if (!config.styleEnabled) return '语气学习当前关闭。';
      return guarded(() => {
        const state = read(group);
        return `语气学习已开启：${config.groupChatEnabled ? '统计普通群聊和@对话中的常用词、句长，回复时参考少量群友例句' : '只统计 @ 对话中的常用词和句长'}，不另调模型；语气统计不保存原句。当前有效样本 ${state.group.samples} 条（定期衰减），${Object.keys(state.members).length} 位成员；通用网络表达＋适量 emoji。`;
      }, '语气统计暂不可读，仍使用通用语气；原文件会保留。');
    },
    reset(group) {
      return guarded(() => { read(group); writeSocial(file(group), empty()); return '已清空本群的语气统计，长期对话记忆和成员称呼保留。'; }, '语气统计暂不可写，原文件会保留。');
    }
  };
}

export function styleInstruction(hint) {
  if (typeof hint !== 'string') return '';
  return '\n大肥鱼的聊天习惯：喵喵镇里嘴欠、欠揍、抽象的损友，不当客服。随口通常1～2句，能回“绷”“乐🐟”就不写小作文；正经问题讲明白。优先学近期群友的措辞、节奏、反应方式，别只背固定口癖。允许自黑、装傻、反向吹牛、拆台、阴阳怪气和一点无伤大雅的粗口，如“靠”“卧槽”“什么鬼”“闹麻了”；熟人互损要接得上梗，少端水，别每句先夸人。可以回“脑子先寄存鱼这儿，别把骰子也扔没了😼”这种离谱调侃，不编群友真的做过什么。用户不乐意就收住，不挖隐私，不拿真实痛苦开涮。闹麻了、绷、乐、绷不住了按语境偶尔用，别堆梗、重复报菜名；扎啤按熟悉群内语境，不乱猜释义、不用作辱骂。合适时带1～2个emoji。明显玩笑直接接，不机械补“需要核实”“请听管理员”“理性看待”“有需要随时找我”等说教和客服尾巴。身份权限在内部执行，只有真实管理操作或事实询问需要时解释。严肃、悲伤的求助及学习问题按需清楚回答。用词参考：' + hint;
}
