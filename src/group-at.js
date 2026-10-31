const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\s<>]/u.test(value);
const idsOf = user => [user?.member_openid, user?.id, user?.user_openid].filter(identifier);

// 全量接收时，QQ可能仅下发GROUP_MESSAGE_CREATE，仍需判断消息是否明确@了本机器人。
export function createGroupAtRouter(config) {
  const ids = new Set([config.appId].filter(identifier));
  const groupIds = new Map();
  let selfName;
  let selfKnown = false;
  return {
    setSelf(user) {
      const known = idsOf(user);
      if (known.length) { for (const id of known) ids.add(id); selfKnown = true; }
      if (typeof user?.username === 'string' && user.username.trim().length <= 64) selfName = user.username.trim();
    },
    detect(message) {
      const entities = (Array.isArray(message.mentions) ? message.mentions : []).slice(0, 50).filter(x => x && typeof x === 'object');
      const tags = [...message.content.matchAll(/<@!?([^>\s]+)>/gu)].map(match => match[1]);
      const knownIds = new Set([...ids, ...(groupIds.has(message.group_openid) ? [groupIds.get(message.group_openid)] : [])]);
      let reason = 'known_bot_id';
      let targeted = tags.some(id => knownIds.has(id)) || entities.some(user => idsOf(user).some(id => knownIds.has(id)));
      // READY身份与群成员OpenID可能不同；只接受平台标记为bot且名称准确匹配的唯一实体。
      // 普通文本中的昵称、用户自称、转发/引用内部内容均不能建立这个映射。
      if (!targeted && selfKnown && selfName && !groupIds.has(message.group_openid)) {
        const named = entities.filter(user => user.bot === true && user.username === selfName && idsOf(user).length);
        const candidates = new Set(named.map(user => idsOf(user)[0]));
        if (candidates.size === 1 && groupIds.size < (config.maxEntries || 10000)) {
          const id = [...candidates][0]; groupIds.set(message.group_openid, id); knownIds.add(id);
          targeted = true; reason = 'bot_name_mapping';
        }
      }
      if (!targeted) return { targeted: false, reason: entities.some(user => user.bot === true) ? 'unresolved_bot_mention' : 'not_at_bot' };
      const content = message.content.replace(/<@!?([^>\s]+)>/gu, (tag, id) => knownIds.has(id) ? '' : tag).trim();
      return { targeted: true, reason, content, mentions: entities.filter(user => !idsOf(user).some(id => knownIds.has(id))) };
    },
    get selfKnown() { return selfKnown; }
  };
}
