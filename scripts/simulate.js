import { randomUUID } from 'node:crypto';
import { MOCK_SECRET } from '../src/config.js';
import { keyPair, signBytes } from '../src/signature.js';

const port = process.env.PORT || '3000';
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PORT 无效');
const base = `http://127.0.0.1:${port}`;
try {
  const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) }).then(x => x.json());
  if (health.mode !== 'mock') throw new Error('not_mock');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = `demo-${randomUUID()}`;
  const raw = JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
    id, group_openid: 'demo-group', author: { member_openid: 'demo-user', bot: false },
    content: '你好，请介绍一下你自己。', timestamp: new Date().toISOString()
  } });
  const result = await fetch(`${base}/qq/webhook`, {
    method: 'POST', signal: AbortSignal.timeout(3000),
    headers: {
      'content-type': 'application/json', 'x-bot-appid': 'demo-app',
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signBytes(keyPair(MOCK_SECRET), timestamp, raw)
    }, body: raw
  });
  if (result.status !== 200) throw new Error('unexpected_status');
  for (let i = 0; i < 20; i++) {
    const messages = await fetch(`${base}/mock/messages`, { signal: AbortSignal.timeout(3000) }).then(x => x.json());
    const reply = messages.find(x => x.msg_id === id);
    if (reply) {
      console.log('签名验证 → 群白名单 → 模拟 AI → 模拟 QQ 回复：通过');
      console.log(reply.content);
      process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('no_reply');
} catch {
  console.error('模拟未完成：请先运行 npm.cmd run demo，确认端口一致；重复演示请间隔 5 秒。此命令只连接本机演示服务。');
  process.exitCode = 1;
}
