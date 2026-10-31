import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { communityKey, writeCommunityFile } from './community.js';

// 只保存统计和发送额度；普通群聊正文不进入此存储。
export function socialFile(config, directory, group) {
  return path.join(path.resolve(directory), `${communityKey(config, group)}.json`);
}

export function readSocial(file, empty, validate) {
  if (!fs.existsSync(file)) return empty();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 524288) throw new Error('invalid_social_file');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const checksum = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');
  if (checksum !== envelope.checksum || !validate(envelope.data)) throw new Error('invalid_social_state');
  return envelope.data;
}

export const writeSocial = writeCommunityFile;
