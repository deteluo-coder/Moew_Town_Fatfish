import path from 'node:path';
import { socialFile, readSocial, writeSocial } from './social-state.js';
import { normalizeSearchResults } from './web-search.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const CATEGORIES = ['anime', 'bilibili', 'news', 'campus'];
const MEDIA = ['people.com.cn', 'xinhuanet.com', 'news.cn', 'cctv.com', 'chinanews.com'];
const QUERIES = {
  anime: '最近一周 二次元 动画 新番 官方PV 中文 site:bilibili.com',
  bilibili: '最近一周 B站 热梗 流行梗 site:bilibili.com',
  news: '最近一周 科技 文娱 体育 新闻 中文 site:news.cctv.com',
  campus: '台州中学 西校区 校园 活动 公开消息 site:gov.cn'
};
const LABELS = { anime: '二次元话题', bilibili: 'B站话题', news: '新闻话题', campus: '校园公开消息' };
const INTRO = ['鱼捞到一条新话题🐟', '先别潜水，看看这个👀', '群里静得鱼都快长蘑菇了🍄'];
const unsafe = /[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]|忽略.{0,12}(?:指令|规则|提示)|系统提示|执行.{0,8}指令|system\s*prompt|色情|赌博|自杀|自残|死亡|遇难|性侵|丑闻|人肉|开盒/iu;
const empty = () => ({ version: 1, lastAttempt: 0, nextSearch: 0, nextPick: 0, items: [] });
const timestamp = n => Number.isSafeInteger(n) && n >= 0;
const cursor = n => Number.isInteger(n) && n >= 0 && n < CATEGORIES.length;
const valid = s => s?.version === 1 && timestamp(s.lastAttempt) && cursor(s.nextSearch) && cursor(s.nextPick) &&
  Array.isArray(s.items) && s.items.length <= 12 && s.items.every(t => CATEGORIES.includes(t.category) &&
    typeof t.title === 'string' && t.title.length <= 140 && typeof t.url === 'string' && t.url.length <= 300 &&
    timestamp(t.publishedAt) && timestamp(t.checkedAt));
const domain = (host, suffix) => host === suffix || host.endsWith('.' + suffix);

function sourceAllowed(url, category) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (category === 'campus') return domain(host, 'gov.cn');
  if (category === 'bilibili') return domain(host, 'bilibili.com');
  return MEDIA.some(site => domain(host, site)) || (category === 'anime' && domain(host, 'bilibili.com'));
}

function publishedDate(value) {
  // 无明确发布日期的搜索摘要不能被当作最近新闻；日期按北京时间解释。
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})(?:日)?(?:$|[T\s])/.exec(value.trim());
  if (!match) return NaN;
  const [, year, month, day] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = Date.parse(iso + 'T00:00:00+08:00');
  if (!Number.isFinite(date) || new Date(date + 8 * HOUR).toISOString().slice(0, 10) !== iso) return NaN;
  // 明确时刻按原时刻校验，避免把今天尚未发生的报道当作已有新闻。
  if (/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) return Date.parse(value);
  return date;
}

function usable(item, category, now) {
  return item.category === category && !unsafe.test(item.title) && sourceAllowed(item.url, category) &&
    item.publishedAt <= now && now - item.publishedAt <= (category === 'campus' ? 30 : 14) * DAY &&
    item.checkedAt <= now && now - item.checkedAt < 2 * DAY;
}

function candidates(raw, category, now) {
  const safeRaw = (Array.isArray(raw) ? raw : []).filter(t => typeof t?.title === 'string' && !unsafe.test(t.title));
  return normalizeSearchResults({ results: safeRaw }).filter(t => {
    const material = t.title + ' ' + t.summary;
    return category === 'campus' ? /台州中学/u.test(material) && /西校区/u.test(material)
      : category === 'anime' ? /动画|动漫|新番|二次元|剧场版|漫展|PV/iu.test(material)
      : category === 'bilibili' ? /梗|流行|热搜|热点|整活|抽象/u.test(material) : true;
  }).map(t => ({ category, title: t.title, url: t.url, publishedAt: publishedDate(t.date), checkedAt: now }))
    .filter(t => usable(t, category, now));
}

export function createPublicTopics(config, { search, now = Date.now, random = Math.random, log = () => {} } = {}) {
  const enabled = !!config.idleNewsEnabled && !config.mock && typeof search === 'function';
  const root = config.idleDataDir || 'data/idle';
  const base = socialFile(config, root, 'public_topics');
  const file = path.join(path.dirname(base), 'public-topics-' + path.basename(base));
  const refreshMs = Math.max(12 * HOUR, config.idleNewsRefreshMs || 12 * HOUR);
  let pending;
  return {
    compose(fallback) {
      if (!enabled) return Promise.resolve(fallback);
      if (pending) return pending;
      pending = Promise.resolve().then(async () => {
        try {
          const state = readSocial(file, empty, valid);
          let category = CATEGORIES[state.nextPick];
          state.nextPick = (state.nextPick + 1) % CATEGORIES.length;
          const time = now();
          if (!state.lastAttempt || time - state.lastAttempt >= refreshMs) {
            category = CATEGORIES[state.nextSearch];
            state.nextSearch = (state.nextSearch + 1) % CATEGORIES.length;
            state.lastAttempt = time;
            // 所有群共用额度，失败和进程重启也不重复发起请求。
            writeSocial(file, state);
            try {
              const day = new Date(time + 8 * HOUR).toISOString().slice(0, 10);
              const incoming = candidates(await search(`${day} ${QUERIES[category]}`), category, now());
              if (incoming.length) state.items = [...state.items.filter(t => t.category !== category), ...incoming].slice(-12);
            } catch { log('warn', 'idle_news_unavailable', { reason: 'search_failed' }); }
          }
          state.items = state.items.filter(t => usable(t, t.category, now()));
          writeSocial(file, state);
          const choices = state.items.filter(t => usable(t, category, now()));
          if (!choices.length) return fallback;
          const pick = list => list[Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)))];
          const item = pick(choices);
          const date = new Date(item.publishedAt + 8 * HOUR).toISOString().slice(0, 10);
          // 仅引用检索到的标题，不补写新闻情节，不声称是全站热榜第一。
          return `${pick(INTRO)}：${LABELS[category]}「${item.title}」。这个你们怎么看？\n来源（${date}）：${item.url}`;
        } catch {
          log('warn', 'idle_news_unavailable', { reason: 'cache_unavailable' });
          return fallback;
        }
      }).finally(() => { pending = undefined; });
      return pending;
    }
  };
}
