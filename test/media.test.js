import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';
import { createDeepseek, createQQ } from '../src/clients.js';
import { createMedia, downloadPublic, imageFromBytes, publicImageURL, isPublicIP, MediaError } from '../src/media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXYkAAAAASUVORK5CYII=', 'base64');
const env = { QQ_APP_ID: 'test', QQ_APP_SECRET: 'secret', DEEPSEEK_API_KEY: 'key' };
const config = extra => ({ ...loadConfig(env), contextPersist: false, contextCompact: false,
  cooldownMs: 0, groups: new Set(['g']), ...extra });
const attachment = { content_type: 'image/png', url: 'https://example.com/photo.png', size: png.length };
const event = (content, id = 'm1', extra = {}) => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id, content, group_openid: 'g', author: { member_openid: 'u' }, timestamp: new Date().toISOString(), ...extra
} });
const json = data => new Response(JSON.stringify(data));

test('图片配置校验开关与大小范围，默认无需第二个模型密钥', () => {
  const c = loadConfig(env);
  assert.equal(c.visionEnabled, true);
  assert.equal(c.visionModel, 'deepseek-flash');
  assert.throws(() => loadConfig({ ...env, IMAGE_MAX_BYTES: '5000001' }));
  assert.throws(() => loadConfig({ ...env, VISION_ENABLED: 'yes' }));
});

test('公网 URL 拒绝凭证、内网、特殊协议与危险端口', () => {
  for (const url of ['http://example.com/a', 'file:///a', 'https://u:p@example.com/a',
    'https://127.0.0.1/a', 'https://2130706433/a', 'https://[::ffff:127.0.0.1]/a',
    'https://169.254.169.254/a', 'https://10.0.0.1/a', 'https://foo.local/a', 'https://x.example:8443/a']) {
    assert.throws(() => publicImageURL(url), undefined, url);
  }
  assert.equal(publicImageURL('//example.com/image.png#fragment').href, 'https://example.com/image.png');
  assert.equal(isPublicIP('8.8.8.8'), true);
  assert.equal(isPublicIP('100.100.100.200'), false);
  assert.equal(isPublicIP('2001:db8::1'), false);
});

function fakeRequest(status, headers, body, inspect = () => {}) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = error => { req.emit('error', error); req.emit('close'); };
    queueMicrotask(() => {
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        if (error) return req.destroy(error);
        inspect(url, options, addresses);
        const res = Readable.from(body.map(chunk => Buffer.from(chunk)));
        res.statusCode = status;
        res.headers = headers;
        res.on('close', () => req.emit('close'));
        callback(res);
      });
    });
    return req;
  };
}

test('下载时阻止解析到内网和 DNS 混合地址，连接固定到验证后的 IP', async () => {
  const options = { maxBytes: 100, timeout: 1000, request: fakeRequest(200, {}, ['ok']) };
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    await assert.rejects(downloadPublic('https://example.com/a', { ...options,
      lookup: (host, opts, callback) => callback(null, addresses) }), /blocked_dns/);
  }
  let pinned;
  assert.equal((await downloadPublic('https://example.com/a', { ...options,
    request: fakeRequest(200, {}, ['ok'], (url, opts, addresses) => { pinned = addresses; assert.equal(opts.agent, false); }),
    lookup: (host, opts, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }]) })).toString(), 'ok');
  assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }]);
});

test('下载阻止重定向进内网、响应超限和网页伪装成图片', async () => {
  const opts = { maxBytes: 4, timeout: 1000,
    lookup: (host, options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }]) };
  await assert.rejects(downloadPublic('https://example.com/a', { ...opts,
    request: fakeRequest(302, { location: 'https://127.0.0.1/a' }, []) }), /blocked_url/);
  await assert.rejects(downloadPublic('https://example.com/a', { ...opts,
    request: fakeRequest(200, {}, ['abc', 'def']) }), /image_too_large/);
  assert.throws(() => imageFromBytes(Buffer.from('<html>not an image</html>'), 100), /invalid_image/);
  assert.equal(imageFromBytes(png, 1000).mime, 'image/png');
});

test('DeepSeek 识图以当前 user 图文块发送，历史仍是纯文本', async () => {
  let body;
  const ask = createDeepseek(config(), async (url, init) => {
    body = JSON.parse(init.body);
    return json({ choices: [{ message: { content: '图片里有鱼' } }] });
  });
  await ask('这是什么', [{ role: 'user', content: '旧文字' }], 'member_test', [imageFromBytes(png, 1000)]);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.messages[1].content, '旧文字');
  assert.equal(body.messages[2].content[1].type, 'image_url');
  assert.match(body.messages[2].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(body.messages[2].name, 'member_test');
});

test('机器人下载当前附件并识图，下一轮只保存文字分析和图片标记', async () => {
  const c = config();
  const calls = [];
  const media = createMedia(c, { download: async () => png });
  const bot = createBot(c, { media, ask: async (...args) => { calls.push(args); return '图片里有鱼'; }, qq: { send: async () => {} }, log: () => {} });
  bot.submit(event('', 'image', { attachments: [attachment] }));
  await bot.drain();
  bot.submit(event('刚才看到什么', 'followup'));
  await bot.drain();
  assert.equal(calls[0][3].length, 1);
  assert.match(calls[0][0], /描述/);
  const history = JSON.stringify(calls[1][1]);
  assert.match(history, /原图未保存/);
  assert.match(history, /图片里有鱼/);
  assert.ok(!history.includes('data:image') && !history.includes('example.com'));
});

test('超量图片、关闭识图和无权限群不会调用模型或下载', async () => {
  let downloads = 0;
  let asks = 0;
  const replies = [];
  const c = config({ maxImages: 1 });
  const bot = createBot(c, { media: createMedia(c, { download: async () => { downloads++; return png; } }),
    ask: async () => { asks++; return 'ok'; }, qq: { send: async (...args) => replies.push(args) }, log: () => {} });
  bot.submit(event('看图', 'too-many', { attachments: [attachment, attachment] }));
  await bot.drain();
  assert.match(replies[0][2], /最多看 1 张/);
  assert.equal(bot.submit(event('看图', 'denied', { group_openid: 'other', attachments: [attachment] })).reason, 'group_denied');
  c.visionEnabled = false;
  bot.submit(event('看图', 'disabled', { attachments: [attachment] }));
  await bot.drain();
  assert.equal(downloads, 0);
  assert.equal(asks, 0);
});

test('表情按群持久保存，普通成员不能写入，拒绝越界名称并限制数量', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fatfish-memes-'));
  try {
    const c = config({ memeDataDir: directory, maxMemesPerGroup: 1 });
    const media = createMedia(c, { download: async () => png });
    const message = event('').d;
    message.attachments = [attachment];
    await assert.rejects(media.save('g', '开心', message), /meme_admin_required/);
    message.author.member_role = 'admin';
    await assert.rejects(media.save('g', '../escape', message), /invalid_meme_name/);
    await media.save('g', '开心', message);
    assert.deepEqual(media.list('g'), ['开心']);
    assert.deepEqual(media.list('other'), []);
    assert.deepEqual(createMedia(c).meme('g', '开心').image.bytes, png);
    await assert.rejects(media.save('g', '难过', message), /meme_limit/);
    await media.save('g', '开心', message);
    assert.equal(readdirSync(directory).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('搜图保留真实作者、许可和来源，只选 PNG/JPG', async () => {
  const media = createMedia(config({ imageSearchProvider: 'commons' }), { download: async url => url.includes('/w/api.php')
    ? Buffer.from(JSON.stringify({ query: { pages: { 1: { title: 'File:Cat.jpg', imageinfo: [{
      mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/cat.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cat.jpg', extmetadata: {
        Artist: { value: '<a>真实作者</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }
      }
    }] } } } })) : png });
  const result = await media.search('猫');
  assert.match(result.caption, /真实作者/);
  assert.match(result.caption, /CC BY-SA 4.0/);
  assert.match(result.caption, /https:\/\/commons.wikimedia.org\/wiki\/File:Cat.jpg/);
  assert.equal(result.image.ext, 'png');
});

test('必应搜图只使用页面实际图片链接，失败时可退到搜索缩略图', async () => {
  const record = { t: '猫咪', purl: 'https://example.com/cat', murl: 'https://example.com/missing.jpg', turl: 'https://tse1.mm.bing.net/cat.jpg' };
  const html = `<a m="${JSON.stringify(record).replace(/"/g, '&quot;')}">test</a>`;
  const mediaWithError = createMedia(config(), { download: async url => {
    if (url.includes('/images/search')) { assert.match(url, /adlt=strict/); return Buffer.from(html); }
    if (url.includes('missing')) throw new MediaError('download_failed');
    return png;
  } });
  const found = await mediaWithError.search('猫咪');
  assert.match(found.caption, /来源网页：https:\/\/example.com\/cat/);
  assert.deepEqual(found.image.bytes, png);
});

test('QQ 先上传不主动发言，再发送被动富媒体，来源说明使用第二序号', async () => {
  const requests = [];
  const qq = createQQ(config(), async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return json(url.endsWith('getAppAccessToken') ? { access_token: 'test-token', expires_in: 7200 }
      : url.endsWith('/files') ? { file_info: 'file-info' } : { id: 'sent' });
  });
  const info = await qq.uploadImage('g', imageFromBytes(png, 1000));
  assert.equal(requests[1].body.srv_send_msg, false);
  assert.deepEqual(Buffer.from(requests[1].body.file_data, 'base64'), png);
  await qq.sendImage('g', 'm', info);
  await qq.send('g', 'm', '来源', 2);
  assert.deepEqual(requests[2].body, { msg_type: 7, media: { file_info: 'file-info' }, msg_id: 'm', msg_seq: 1 });
  assert.equal(requests[3].body.msg_seq, 2);
});

test('图片发送失败不重试不追加故障回复；指令不调用 AI', async () => {
  let sends = 0;
  let asks = 0;
  let textSends = 0;
  const bot = createBot(config(), { media: { fromURL: async () => ({ image: {} }) },
    ask: async () => { asks++; }, log: () => {}, qq: {
      uploadImage: async () => 'info', sendImage: async () => { sends++; throw new Error('ambiguous'); },
      send: async () => { textSends++; }
    } });
  bot.submit(event('发图 https://example.com/a.png'));
  await bot.drain();
  assert.equal(sends, 1);
  assert.equal(asks, 0);
  assert.equal(textSends, 0);
});
