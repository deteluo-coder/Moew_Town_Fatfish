import { createServer } from 'node:http';
import { keyPair, signBytes, verifyRequest } from './signature.js';
import { createBot } from './bot.js';
import { createDeepseek, createQQ, createSummarizer } from './clients.js';
import { createLogger } from './log.js';

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, max) {
  let size = 0;
  const chunks = [];
  // 不使用异步迭代器，以便超限后仍可返回 413，而不是直接销毁连接。
  return new Promise((resolve, reject) => {
    let rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (rejected) return;
      if (size > max) {
        rejected = true;
        reject(Object.assign(new Error('body_limit'), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

export function buildServer(config, dependencies = {}) {
  const log = dependencies.log || createLogger();
  const now = dependencies.now || Date.now;
  const keys = keyPair(config.appSecret);
  const mockMessages = [];
  const ask = dependencies.ask || (config.mock
    ? async () => '离线演示成功：已验证群聊 @ 事件，并生成模拟回复。真实模式会调用 DeepSeek。'
    : createDeepseek(config, fetch, log));
  const qq = dependencies.qq || (config.mock ? {
    async send(group, messageId, content) {
      mockMessages.push({ group_openid: group, msg_id: messageId, msg_seq: 1, content });
      if (mockMessages.length > 50) mockMessages.shift();
    }
  } : createQQ(config));
  const summarize = dependencies.summarize || (config.mock ? undefined : createSummarizer(config));
  const bot = createBot(config, { ask, qq, log, summarize, now });
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') {
        return json(res, 200, { ok: true, mode: config.mock ? 'mock' : 'live', inflight: bot.inflight,
          app: 'qq-deepseek-bot', transport: config.transport || 'webhook',
          group_events: bot.groupStatus,
          ...((config.groupChatEnabled || config.groupAtOnly) ? { group_chat: bot.groupChatStatus } : {}),
          ...(dependencies.gatewayStatus ? { gateway: dependencies.gatewayStatus() } : {}),
          ...(config.idleEnabled ? { idle: bot.idleStatus } : {}),
          ...(config.dmEnabled ? { private_chat: bot.privateStatus } : {}),
          ...(config.trendsEnabled ? { trends: bot.trendStatus } : {}) });
      }
      if (config.mock && req.method === 'GET' && path === '/mock/messages') return json(res, 200, mockMessages);
      if (path !== '/qq/webhook') return json(res, 404, { error: 'not_found' });
      if (config.transport === 'websocket') return json(res, 409, { error: 'websocket_transport_active' });
      if (req.method !== 'POST') return json(res, 405, { error: 'post_required' });
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        return json(res, 415, { error: 'json_required' });
      }
      const raw = await readBody(req, config.maxBodyBytes);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { return json(res, 400, { error: 'invalid_json' }); }
      // 官方 op=13 地址验证示例没有签名头；仅此握手分支允许未签名请求。
      if (payload?.op === 13) {
        const data = payload.d;
        if (req.headers['x-bot-appid'] !== config.appId) return json(res, 401, { error: 'wrong_app' });
        // 限制为令牌字符，不能让未签名握手替任意 JSON 事件生成可复用的签名。
        if (typeof data?.plain_token !== 'string' || !/^[A-Za-z0-9_+/=-]{1,256}$/.test(data.plain_token) ||
            typeof data.event_ts !== 'string' || !/^\d{10}$/.test(data.event_ts) ||
            Math.abs(now() / 1000 - Number(data.event_ts)) > config.signatureMaxAge) {
          return json(res, 400, { error: 'invalid_challenge' });
        }
        return json(res, 200, { plain_token: data.plain_token, signature: signBytes(keys, data.event_ts, data.plain_token) });
      }
      if ((req.headers['x-bot-appid'] && req.headers['x-bot-appid'] !== config.appId) ||
          !verifyRequest(keys, req.headers, raw, now(), config.signatureMaxAge)) {
        log('warn', 'signature_rejected');
        return json(res, 401, { error: 'invalid_signature' });
      }
      const result = bot.submit(payload);
      if (result.kind === 'busy') return json(res, 503, { error: 'busy_retry_later' });
      if (result.kind === 'ignored') log('info', 'event_ignored', { reason: result.reason });
      // 先完成回调 ACK，后台异步生成与发送；不让模型耗时阻塞 QQ 的回调。
      return json(res, 200, { op: 12 });
    } catch (error) {
      log('error', 'request_failed', { reason: error.status === 413 ? 'body_limit' : 'invalid_request' });
      if (!res.headersSent) json(res, error.status === 413 ? 413 : 400, { error: error.status === 413 ? 'body_too_large' : 'bad_request' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 10000;
  return { server, bot, qq, mockMessages };
}
