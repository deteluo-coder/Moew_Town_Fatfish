import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// QQ 官方算法：重复 Secret 的 UTF-8 字节并取前 32 字节，作为 Ed25519 seed。
export function keyPair(secret) {
  const bytes = Buffer.from(secret, 'utf8');
  if (!bytes.length) throw new Error('QQ_APP_SECRET 不能为空');
  const seed = Buffer.alloc(32);
  for (let i = 0; i < seed.length; i++) seed[i] = bytes[i % bytes.length];
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8'
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function signBytes(keys, timestamp, body) {
  return sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), keys.privateKey).toString('hex');
}

export function verifyRequest(keys, headers, rawBody, now = Date.now(), maxAge = 300) {
  const timestamp = headers['x-signature-timestamp'];
  const signature = headers['x-signature-ed25519'];
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > maxAge) return false;
  if (typeof signature !== 'string' || !/^[a-f\d]{128}$/i.test(signature)) return false;
  return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.publicKey, Buffer.from(signature, 'hex'));
}
