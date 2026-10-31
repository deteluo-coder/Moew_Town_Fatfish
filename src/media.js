import { get } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class MediaError extends Error {
  constructor(reason, publicMessage = '图片处理暂时失败，请换一张较小的 PNG/JPG 图片重试。') {
    super(reason);
    this.reason = reason;
    this.publicMessage = publicMessage;
  }
}

export function isPublicIP(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // 仅接受全局单播；排除映射 IPv4、链路本地、回环、文档和过渡地址。
  return isIP(address) === 6 && /^[23][0-9a-f]{0,3}:/i.test(address) &&
    !/^2001:(?:0{0,4}:|0?db8:|0?10:|0?20:)/i.test(address) && !/^2002:/i.test(address);
}

export function publicImageURL(value) {
  let url;
  try { url = new URL(value?.startsWith('//') ? `https:${value}` : value); }
  catch { throw new MediaError('invalid_url', '请提供可公开访问的 HTTPS 图片直链。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.href.length > 8192 || url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || host.endsWith('.') || !host.includes('.') ||
      /\.(?:localhost|local|internal|lan)$/i.test(host) || (isIP(host) && !isPublicIP(host))) {
    throw new MediaError('blocked_url', '只接受公开网络上的 HTTPS 图片直链，不支持本机或内网地址。');
  }
  url.hash = '';
  return url;
}

export function imageFromBytes(bytes, maxBytes, { outgoing = false } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) {
    throw new MediaError('image_too_large', `图片需小于 ${Math.floor(maxBytes / 1000000)} MB，请压缩后重试。`);
  }
  let ext;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ext = 'png';
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ext = 'jpg';
  else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) ext = 'gif';
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
  else throw new MediaError('invalid_image', '链接返回的不是支持的图片，请使用图片直链；网页链接不能当图片发送。');
  if (outgoing && !['png', 'jpg'].includes(ext)) {
    throw new MediaError('unsupported_outgoing', '当前发图和表情包支持静态 PNG/JPG，请先把动图或 WebP 转为 PNG/JPG。');
  }
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return { bytes, ext, mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
}

// 在连接时校验 DNS 返回地址，并将连接锁定到该结果；每次重定向重新校验。
// 不携带 QQ/DeepSeek 密钥或用户 Cookie，不允许退回 HTTP。
export function downloadPublic(urlValue, { maxBytes, timeout, request = get, lookup = dnsLookup }, redirects = 0, deadline = Date.now() + timeout) {
  const url = publicImageURL(urlValue);
  return new Promise((resolveDownload, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new MediaError('download_timeout'));
    let timer;
    const fail = error => reject(error instanceof MediaError ? error : new MediaError('download_failed'));
    const req = request(url, {
      agent: false, family: 4,
      headers: { 'user-agent': 'FatfishQQBot/0.4 (https://github.com/deteluo-coder/Moew_Town_Fatfish)', accept: 'image/*, application/json;q=0.8, text/html;q=0.7' },
      lookup(host, options, callback) {
        lookup(host, { all: true, verbatim: true }, (error, records) => {
          if (error || !records?.length || records.some(record => !isPublicIP(record.address))) {
            return callback(new MediaError('blocked_dns'));
          }
          const selected = records.find(record => record.family === 4) || records[0];
          callback(null, options.all ? [selected] : selected.address, selected.family);
        });
      }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 3 || !res.headers.location) return fail(new MediaError('redirect_limit'));
        let next;
        try { next = publicImageURL(new URL(res.headers.location, url).href); } catch (error) { return fail(error); }
        return downloadPublic(next.href, { maxBytes, timeout, request, lookup }, redirects + 1, deadline).then(resolveDownload, fail);
      }
      if (res.statusCode !== 200) { res.resume(); return fail(new MediaError('image_http_error')); }
      const sizeHeader = Number(res.headers['content-length']);
      if (sizeHeader > maxBytes) { res.destroy(); return fail(new MediaError('image_too_large')); }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(new MediaError('image_too_large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolveDownload(Buffer.concat(chunks)));
      res.on('error', fail);
    });
    timer = setTimeout(() => req.destroy(new MediaError('download_timeout')), remaining);
    req.on('error', fail);
    req.on('close', () => clearTimeout(timer));
  });
}

export function imageAttachments(message) {
  return (Array.isArray(message.attachments) ? message.attachments : []).filter(item =>
    item && (typeof item.content_type === 'string' && /^image\/(jpeg|png|gif|webp)$/i.test(item.content_type) ||
      (!item.content_type && item.width > 0 && item.height > 0)));
}

const safeName = name => typeof name === 'string' && /^[\p{L}\p{N}_-]{1,30}$/u.test(name);

export function createMedia(config, { download = downloadPublic, random = Math.random, describe, log = () => {} } = {}) {
  const options = { maxBytes: config.imageMaxBytes, timeout: config.imageTimeout };
  async function readImage(url, outgoing = false) {
    return imageFromBytes(await download(publicImageURL(url).href, options), config.imageMaxBytes, { outgoing });
  }
  function groupDir(group) {
    return join(resolve(config.memeDataDir), createHash('sha256').update(config.appId).update('\0').update(group).digest('hex'));
  }
  function files(group) {
    try {
      return readdirSync(groupDir(group), { withFileTypes: true }).filter(item => item.isFile() &&
        /\.(png|jpg)$/.test(item.name) && safeName(item.name.replace(/\.(png|jpg)$/, ''))).map(item => item.name);
    } catch (error) { if (error.code === 'ENOENT') return []; throw new MediaError('meme_storage_failed'); }
  }
  function requireName(name) {
    if (!safeName(name)) throw new MediaError('invalid_meme_name', '表情名称限 1～30 个中文、字母、数字、下划线或短横线。');
  }
  async function annotate(group, name) {
    requireName(name);
    if (!describe || config.mock) return false;
    const filename = files(group).find(file => file.replace(/\.(png|jpg)$/, '') === name);
    if (!filename) return false;
    const directory = groupDir(group);
    const path = join(directory, filename);
    let temporary;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > config.imageMaxBytes) return false;
      const image = imageFromBytes(readFileSync(path), config.imageMaxBytes, { outgoing: true });
      const imageHash = createHash('sha256').update(image.bytes).digest('hex');
      const description = await describe(image);
      if (typeof description !== 'string' || !description.trim() || Array.from(description).length > 160) return false;
      // 等待模型期间图片可能被覆盖，旧标签不能附到新图片上。
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== imageHash) return false;
      const current = lstatSync(path);
      temporary = join(directory, `.tmp-${randomUUID()}`);
      writeFileSync(temporary, JSON.stringify({ version: 1, imageHash, size: current.size,
        mtimeMs: current.mtimeMs, description: description.trim() }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, join(directory, `${name}.meta.json`));
      return true;
    } catch {
      log('warn', 'meme_annotation_failed', { reason: 'description_unavailable' });
      return false;
    } finally { if (temporary) { try { unlinkSync(temporary); } catch {} } }
  }
  return {
    annotate,
    sources(group) {
      try {
        const file = join(groupDir(group), 'meme-sources.json');
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > 32768) return [];
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(data)) return [];
        return data.slice(0, 100).filter(item => safeName(item?.name) &&
          ['author', 'pack', 'license'].every(key => typeof item[key] === 'string' && item[key].trim() && item[key].length <= 100))
          .flatMap(item => {
            try { return [{ name: item.name, author: item.author, pack: item.pack, license: item.license,
              source: publicImageURL(item.source).href, licenseUrl: publicImageURL(item.licenseUrl).href }]; } catch { return []; }
          });
      } catch { return []; }
    },
    catalog(group) {
      return files(group).map(filename => {
        const name = filename.replace(/\.(png|jpg)$/, '');
        let description = name;
        try {
          const metadataPath = join(groupDir(group), `${name}.meta.json`);
          const metadataStat = lstatSync(metadataPath);
          if (metadataStat.isFile() && metadataStat.size <= 8192) {
            const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
            const stat = lstatSync(join(groupDir(group), filename));
            if (metadata.version === 1 && stat.isFile() && metadata.size === stat.size && metadata.mtimeMs === stat.mtimeMs &&
                typeof metadata.description === 'string' && metadata.description.trim() && Array.from(metadata.description).length <= 160) {
              description = metadata.description.trim();
            }
          }
        } catch {}
        return { name, description };
      });
    },
    async images(message) {
      const attachments = imageAttachments(message);
      if (attachments.length > config.maxImages) throw new MediaError('too_many_images', `一次最多看 ${config.maxImages} 张图片，请分开发送。`);
      const images = [];
      for (const attachment of attachments) {
        if (attachment.size > config.imageMaxBytes) throw new MediaError('image_too_large');
        images.push(await readImage(attachment.url));
      }
      return images;
    },
    async fromURL(url) { return { image: await readImage(url, true) }; },
    list(group) { return files(group).map(file => file.replace(/\.(png|jpg)$/, '')); },
    async save(group, name, message) {
      requireName(name);
      if (!message.privateChat && !['admin', 'owner'].includes(message.author?.member_role)) {
        throw new MediaError('meme_admin_required', '保存表情包需要群主或管理员操作；若平台未返回群内身份，也无法保存。');
      }
      const attachments = imageAttachments(message);
      if (attachments.length !== 1) throw new MediaError('meme_image_required', '请把“存表情 名称”和一张 PNG/JPG 图片放在同一条 @ 消息中发送。');
      const existing = files(group);
      const sameName = existing.filter(file => file.replace(/\.(png|jpg)$/, '') === name);
      if (!sameName.length && existing.length >= config.maxMemesPerGroup) throw new MediaError('meme_limit', '本群表情包库已满，请联系维护者整理。');
      const image = await readImage(attachments[0].url, true);
      const directory = groupDir(group);
      let temporary;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        temporary = join(directory, `.tmp-${randomUUID()}`);
        writeFileSync(temporary, image.bytes, { flag: 'wx', mode: 0o600 });
        const filename = `${name}.${image.ext}`;
        renameSync(temporary, join(directory, filename));
        for (const old of sameName) if (old !== filename) unlinkSync(join(directory, old));
      } catch { throw new MediaError('meme_storage_failed'); }
      finally { if (temporary) { try { unlinkSync(temporary); } catch {} } }
      if (config.autoMemeEnabled) await annotate(group, name);
      return `已保存表情“${name}”，本群可以用“@机器人 表情 ${name}”发送。`;
    },
    meme(group, name = '') {
      const available = files(group);
      if (!available.length) throw new MediaError('meme_empty', '本群还没有表情包。请群主或管理员发送“@机器人 存表情 开心”，并在同一条消息中附上 PNG/JPG 图片。');
      if (name) requireName(name);
      const filename = name ? available.find(file => file.replace(/\.(png|jpg)$/, '') === name)
        : available[Math.min(available.length - 1, Math.floor(random() * available.length))];
      if (!filename) throw new MediaError('meme_not_found', '没找到这个表情，请用“表情列表”查看已保存的名称。');
      const path = join(groupDir(group), filename);
      try {
        if (!lstatSync(path).isFile() || lstatSync(path).size > config.imageMaxBytes) throw new Error('invalid file');
        return { image: imageFromBytes(readFileSync(path), config.imageMaxBytes, { outgoing: true }) };
      } catch (error) { throw error instanceof MediaError ? error : new MediaError('meme_storage_failed'); }
    },
    async search(query) {
      if (!query || Array.from(query).length > 100) throw new MediaError('invalid_search', '用法：@机器人 搜图 关键词，关键词不超过 100 字。');
      if (config.imageSearchProvider === 'bing') {
        const endpoint = new URL('https://www.bing.com/images/search');
        endpoint.search = new URLSearchParams({ q: query, first: '1', adlt: 'strict' }).toString();
        let html;
        try { html = (await download(endpoint.href, { ...options, maxBytes: 2500000 })).toString('utf8'); }
        catch { throw new MediaError('search_failed', '暂时无法连接搜图服务，请稍后再试，也可以用“发图 HTTPS图片直链”。'); }
        const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        let candidates = 0;
        for (const match of html.matchAll(/\bm="([^\"]+)"/g)) {
          let record;
          try { record = JSON.parse(decode(match[1])); } catch { continue; }
          if (++candidates > 5) break;
          // 只使用搜索服务实际给出的链接，不让语言模型猜测图片地址。
          const title = String(record.t || '联网图片').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 150);
          let source;
          try { source = publicImageURL(record.purl).href; } catch { continue; }
          for (const target of [record.murl, record.turl]) {
            if (typeof target !== 'string') continue;
            try { return { image: await readImage(target, true), caption: `${title}\n来源网页：${source}` }; }
            catch (error) { if (!(error instanceof MediaError)) throw error; }
          }
        }
        throw new MediaError('image_not_found', '暂未找到可发送的图片，请换个关键词，或用“发图 HTTPS图片直链”。');
      }
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      url.search = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: query,
        gsrnamespace: '6', gsrlimit: '5', prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '960',
        iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|AttributionRequired' }).toString();
      let data;
      try { data = JSON.parse((await download(url.href, { ...options, maxBytes: 262144 })).toString('utf8')); }
      catch { throw new MediaError('search_failed', '暂时无法连接图库，请稍后再试，也可以用“发图 HTTPS图片直链”。'); }
      const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info || !['image/jpeg', 'image/png'].includes(info.mime)) continue;
        const imageURL = info.thumburl || info.url;
        const metadata = info.extmetadata || {};
        const clean = value => String(value || '').replace(/<[^>]*>/g, '').replace(/&(?:[a-z]+|#\d+);/g, ' ').replace(/\s+/g, ' ').trim();
        const artist = clean(metadata.Artist?.value);
        const license = clean(metadata.LicenseShortName?.value);
        if (!artist || artist.length > 400 || !license || license.length > 100) continue;
        try {
          const target = publicImageURL(imageURL);
          if (!target.hostname.endsWith('.wikimedia.org') || !info.descriptionurl?.startsWith('https://commons.wikimedia.org/wiki/')) continue;
          return { image: await readImage(target.href, true), caption:
            `${clean(page.title).replace(/^File:/, '').slice(0, 150)}\n作者：${artist}\n许可：${license}\n来源：${info.descriptionurl}` };
        } catch (error) { if (!(error instanceof MediaError)) throw error; }
      }
      throw new MediaError('image_not_found', '图库暂未找到可发送的图片。可以换个词或用英文关键词；也支持“发图 HTTPS图片直链”。');
    }
  };
}
