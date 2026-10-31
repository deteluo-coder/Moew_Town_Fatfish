import path from 'node:path';
import { socialFile, readSocial, writeSocial } from './social-state.js';
import { normalizeSearchResults } from './web-search.js';

export const WELCOMES = [
  '大肥鱼复活，电子鱼粮到货啦🐟🍿 喵喵镇今天在蹲什么新番？快让鱼抄抄安利清单～',
  '叮！一条野生大肥鱼加入聊天🐟✨ 最近有没有让人“这段我能再看十遍”的二次元名场面？',
  '鱼鱼探头，今日份情绪价值已装箱🐟📦 喵喵镇的宝，最近被哪部番、哪个角色狠狠拿捏了？',
  '读条结束，大肥鱼上线🐟🎮 今天的支线任务：交换一个好玩的梗，或者安利一部舍不得快进的番～'
];
const initial = () => ({ version: 1, lastAttempt: 0, lastSent: 0 });
const valid = data => data?.version === 1 && ['lastAttempt', 'lastSent'].every(k => Number.isSafeInteger(data[k]) && data[k] >= 0);
const newsEmpty = () => ({ version: 1, lastAttempt: 0, checkedAt: 0, items: [] });
const newsValid = s => s?.version === 1 && ['lastAttempt', 'checkedAt'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0) &&
  Array.isArray(s.items) && s.items.length <= 3 && s.items.every(t => typeof t.title === 'string' && t.title.length <= 150 && typeof t.url === 'string' && t.url.length <= 400);

export function createStartupPolicy(config, { now = Date.now, random = Math.random, log = () => {}, search } = {}) {
  const attempted = new Set();
  let newsPending;
  const root = config.startupDataDir || 'data/startup';
  const newsFile = path.join(path.dirname(socialFile(config, root, 'public_news')), 'news-' + path.basename(socialFile(config, root, 'public_news')));
  const stateFile = group => socialFile(config, root, group);
  async function welcome() {
    const index = Math.min(WELCOMES.length - 1, Math.max(0, Math.floor(random() * WELCOMES.length)));
    if (!config.startupNewsEnabled || typeof search !== 'function') return WELCOMES[index];
    if (!newsPending) newsPending = (async () => {
      try {
        const state = readSocial(newsFile, newsEmpty, newsValid);
        if (!state.lastAttempt || now() - state.lastAttempt >= config.startupNewsRefreshMs) {
          state.lastAttempt = now(); writeSocial(newsFile, state);
          const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
          try {
            const results = normalizeSearchResults({ results: await search(`${day} 最近一周 二次元 动画 新番 官方PV 公开播出消息`) });
            state.items = results.filter(t => /动画|新番|动漫|剧场版|漫展|PV/iu.test(t.title) && !/成人|色情|赌博|丑闻|自杀|死亡/u.test(t.title))
              .filter(t => { const date = Date.parse(t.date); return !Number.isFinite(date) || (now() - date < 14 * 86400000 && date - now() < 86400000); })
              .map(t => ({ title: t.title.replace(/[\r\n<>]/g, '').slice(0, 70), url: t.url }));
            if (state.items.length) state.checkedAt = now();
            writeSocial(newsFile, state);
          } catch { log('warn', 'startup_news_unavailable', { reason: 'search_failed' }); }
        }
        if (!state.items.length || now() - state.checkedAt > 2 * 86400000) return undefined;
        return state.items[Math.min(state.items.length - 1, Math.floor(random() * state.items.length))];
      } catch { log('warn', 'startup_news_unavailable', { reason: 'cache_unavailable' }); }
    })().finally(() => { newsPending = undefined; });
    const item = await newsPending;
    return item ? `电子鱼粮到货，大肥鱼复活啦🐟🍿 鱼刚刷到一个二次元话题：「${item.title}」。喵喵镇有没有人蹲这个？来给鱼补补课～` : WELCOMES[index];
  }
  return {
    reserve(group) {
      if (!config.startupEnabled || config.mock || !config.groups.has(group) || attempted.has(group)) return;
      attempted.add(group);
      try {
        const file = stateFile(group); const state = readSocial(file, initial, valid);
        if (state.lastAttempt && now() - state.lastAttempt < config.startupCooldownMs) return;
        state.lastAttempt = now(); writeSocial(file, state);
        return { group };
      } catch { log('warn', 'startup_storage_failed', { reason: 'state_unavailable' }); }
    },
    welcome,
    finish(lease) {
      try { const state = readSocial(stateFile(lease.group), initial, valid); state.lastSent = now(); writeSocial(stateFile(lease.group), state); }
      catch { log('warn', 'startup_storage_failed', { reason: 'write_failed' }); }
    }
  };
}
