import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { communityKey, writeCommunityFile } from '../src/community.js';

try {
  const config = loadConfig();
  const input = process.argv[2];
  const group = process.argv[3] || (config.groups.size === 1 ? [...config.groups][0] : undefined);
  if (!input || !group || (!config.allowAllGroups && !config.groups.has(group))) throw new Error('setup_input');
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.size > 16384) throw new Error('setup_input');
  const background = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (['school', 'club', 'groupDescription', 'ownerBackground'].some(key =>
    typeof background[key] !== 'string' || !background[key].trim() || Array.from(background[key]).length > 400)) throw new Error('setup_input');
  writeCommunityFile(path.resolve(config.communityDataDir, `${communityKey(config, group)}.settings.json`), { version: 1, background });
  console.log('群固定背景已保存，已有成员档案保持。请启用 COMMUNITY_ENABLED=true 并重启机器人。');
} catch {
  console.error('背景配置未保存。用法：node --env-file-if-exists=.env scripts/configure-community.js 背景JSON文件 [已授权群OpenID]。多个授权群时需要指定目标群。');
  process.exitCode = 1;
}
