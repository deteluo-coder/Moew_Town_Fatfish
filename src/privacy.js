const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 本机配置的真实姓名不出现在模型请求和外发文字中，历史记忆无须删除。
export function createPrivacy(config) {
  const replacement = config.ownerDisplayName || '主人';
  const patterns = (config.privateNames || []).filter(Boolean).sort((a, b) => b.length - a.length)
    .map(name => new RegExp(Array.from(name.normalize('NFKC')).map(escape).join('[\\s\\u200b-\\u200f\\u202a-\\u202e·]*'), 'gu'));
  function text(value) {
    if (typeof value !== 'string' || !patterns.length || value.startsWith('data:image/')) return value;
    const view = value.normalize('NFKC');
    const matches = patterns.flatMap(pattern => [...view.matchAll(pattern)].map(match => [match.index, match.index + match[0].length]));
    if (!matches.length) return value;
    let starts; let ends;
    if (view !== value) {
      starts = []; ends = [];
      // 匹配视图规范化；输出保留原来的中文标点、emoji和全角格式。
      let position = 0;
      for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)) {
        const normalized = segment.normalize('NFKC');
        for (let i = 0; i < normalized.length; i++) { starts.push(position); ends.push(position + segment.length); }
        position += segment.length;
      }
    }
    const ranges = matches.map(([start, end]) => [starts ? starts[start] : start, ends ? ends[end - 1] : end])
      .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let cursor = 0; let result = '';
    for (const [start, end] of ranges) {
      if (start < cursor) continue;
      result += value.slice(cursor, start) + replacement; cursor = end;
    }
    return result + value.slice(cursor);
  }
  function value(item) {
    if (typeof item === 'string') return text(item);
    if (Array.isArray(item)) return item.map(value);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, value(v)]));
    return item;
  }
  return { text, value };
}
