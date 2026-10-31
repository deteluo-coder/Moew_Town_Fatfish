import { UpstreamError, createMemeDescriber, createWebSearch, createSlangExtractor } from './clients.js';
import { createHmac } from 'node:crypto';
import { createConversationStore, MemoryStorageError } from './context.js';
import { createMedia, imageAttachments, MediaError } from './media.js';
import { createReactionPolicy } from './reactions.js';
import { createCommunityStore, selfIntroduction } from './community.js';
import { selectWebQuery, formatSourcedReply } from './web-search.js';
import { createStyleStore } from './style.js';
import { createIdlePolicy } from './idle.js';
import { createTrendStore } from './trends.js';
import { createStartupPolicy } from './startup.js';
import { createGroupAtRouter } from './group-at.js';
import { createPrivacy } from './privacy.js';
import { createPublicTopics } from './public-topics.js';
import { createGroupChatStore } from './group-chat.js';

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u0020\u007f]/.test(value);

export function limitReply(text, maxChars) {
  // 阻止模型输出被 QQ 当作 @ 指令解析；只发普通文本。
  const clean = text.replace(/<@[^>]*>/g, '[提及]').replace(/\u0000/g, '');
  const chars = Array.from(clean);
  const suffix = '\n（回复过长，已截断）';
  return chars.length > maxChars ? chars.slice(0, maxChars - Array.from(suffix).length).join('') + suffix : clean;
}

export function createBot(config, { ask, qq, log, summarize, media = createMedia(config, {
  describe: config.autoMemeEnabled && !config.mock ? createMemeDescriber(config) : undefined, log
}), now = Date.now, random = Math.random, community: suppliedCommunity, trends: suppliedTrends,
  search = config.webSearchEnabled && !config.mock ? createWebSearch(config) : undefined }) {
  const seen = new Map();
  const privacy = createPrivacy(config);
  const publicTopics = createPublicTopics(config, { now, random, log, search });
  const cooldown = new Map();
  const tasks = new Set();
  const activeConversations = new Set();
  const memory = createConversationStore(config, now, { log });
  const aliasKey = memory.getAliasKey();
  const groupChat = createGroupChatStore(config, { aliasKey, now, log });
  const community = suppliedCommunity || (config.communityEnabled ? createCommunityStore(config, { aliasKey, log, now }) : undefined);
  const reactions = createReactionPolicy(config, { now, random });
  const style = createStyleStore(config, { aliasKey, log, now });
  const idle = createIdlePolicy(config, { now, random, log });
  const startup = createStartupPolicy(config, { now, random, log, search: search || (config.startupNewsEnabled && !config.mock ? createWebSearch(config) : undefined) });
  const trends = suppliedTrends || createTrendStore(config, { now, log,
    ...(config.trendsEnabled && !config.mock ? { search: search || createWebSearch(config), extract: createSlangExtractor(config) } : {}) });
  const activitySeen = new Map();
  const activeIdleGroups = new Set();
  let recent = [];
  let closing = false;
  let privateReceived = 0;
  const groupAt = createGroupAtRouter(config);
  const groupEvents = { full_received: 0, native_at_received: 0, full_at_recognized: 0, at_accepted: 0, unresolved_bot_mentions: 0 };
  const skip = reason => ({ kind: 'ignored', reason });

  function prune(map, timestamp) {
    for (const [key, expires] of map) if (expires <= timestamp) map.delete(key);
  }

  async function respond(message, prompt, conversationKey) {
    const started = now();
    const privateChat = message.privateChat === true;
    const target = privateChat ? message.author.member_openid : message.group_openid;
    const transport = privateChat ? { send: (...args) => qq.sendPrivate(...args),
      uploadImage: (...args) => qq.uploadPrivateImage(...args), sendImage: (...args) => qq.sendPrivateImage(...args) } : qq;
    let reply;
    let remember = false;
    let rememberedPrompt = prompt;
    let mediaReply;
    let fileInfo;
    let imageOperation = false;
    let reactionLease;
    let reactionName;
    let replySources = [];
    let mediaSelfTest = false;
    const shared = !privateChat && config.contextScope === 'group';
    // 持久化随机盐使重启后的匿名标签保持一致，原始成员 OpenID 不发送给模型。
    const speaker = shared ? 'member_' + createHmac('sha256', aliasKey)
      .update(conversationKey).update('\0').update(message.author.member_openid).digest('hex').slice(0, 12) : undefined;
    try {
      const observed = !privateChat ? community?.observe(message.group_openid, message.author, message.mentions) : undefined;
      if (prompt === '/ping') reply = 'pong：机器人在线。';
      else if (prompt === '热梗状态' || prompt === '热梗列表') reply = trends.status(prompt === '热梗列表');
      else if (prompt === '更新热梗') {
        const result = await trends.refresh();
        reply = (result.kind === 'cached' ? '当前仍在更新间隔内，本次复用缓存，不额外联网。\n' : '') + trends.status(true);
      }
      else if (prompt === '媒体自检' || prompt === '/media-test') {
        imageOperation = true;
        const names = config.imageSendEnabled && !config.mock ? media.list(message.group_openid) : [];
        mediaSelfTest = true; reactionName = names[0];
        reply = 'emoji 测试：🐟 ✨ 😊。' + (reactionName ? '接下来发送当前聊天表情库里的一张PNG/JPG，请检查是否能看到。'
          : config.imageSendEnabled ? '当前聊天还没有可用表情包，可发送“存表情 开心”并附一张PNG/JPG后再试。' : '图片发送当前关闭。');
      }
      else if (prompt === '语气状态' || prompt === '/style') reply = style.status(message.group_openid);
      else if (prompt === '表情来源' || prompt === '/meme-sources') {
        const sources = media.sources?.(message.group_openid) || [];
        const packs = [...new Map(sources.map(item => [item.source + item.author, item])).values()].slice(0, 3);
        reply = packs.length ? '已添加的网络表情来源：\n' + packs.map(item => `${item.pack}／${item.author}\n许可：${item.license}`).join('\n')
          : '当前聊天没有登记网络导入表情来源；群友自行保存的表情请向上传者确认出处。';
        replySources = packs.flatMap(item => [{ title: `${item.pack}／${item.author}`, url: item.source }, { title: `${item.license}许可`, url: item.licenseUrl }]).slice(0, 2);
      }
      else if (prompt === '群聊记录状态' || prompt === '/group-chat') reply = privateChat ? '群聊记录只在对应群内查看，私聊不读取群记录。' : groupChat.status(message.group_openid);
      else if (prompt === '清空群聊记录') reply = privateChat ? '请在对应群中操作群聊记录。' : ['owner', 'admin'].includes(message.author.member_role)
        ? groupChat.clear(message.group_openid) : '清空群聊记录仅限群主或管理员。';
      else if (prompt === '重置语气') reply = !config.styleEnabled ? '语气学习当前关闭。' : privateChat || ['owner', 'admin'].includes(message.author.member_role)
        ? style.reset(message.group_openid) : '重置语气仅限群主或管理员。';
      else if (/^冷群聊天(?:\s|$)/u.test(prompt)) reply = privateChat ? '冷群聊天控制仅群聊可用，请在对应群中操作。' : config.groupAtOnly && !config.idleForceAfterMs
        ? '当前设置为群里只在被@时回复，冷群发言和上线招呼都已关闭。' : idle.command(message.group_openid, prompt.replace(/^冷群聊天\s*/u, ''), message.author.member_role);
      else if (!privateChat && community && /^(?:设置称呼|\/name)(?:\s|$)/u.test(prompt)) {
        const name = prompt.replace(/^(?:设置称呼|\/name)\s*/u, '').trim();
        reply = name ? community.setName(message.group_openid, message.author, name) : '用法：@机器人 设置称呼 小明。';
      } else if (!privateChat && community && (prompt === '我是谁' || prompt === '/whoami')) reply = community.who(message.group_openid, message.author);
      else if (!privateChat && community && selfIntroduction(prompt)) reply = community.setName(message.group_openid, message.author, selfIntroduction(prompt));
      else if (prompt === '/reset' || prompt === '清空记忆') {
        memory.clear(conversationKey);
        reply = privateChat ? '已清空你与大肥鱼的私聊记忆，群聊记忆保留。' : shared ? '已清空本群机器人的对话记忆。' : '已清空你在本群的对话记忆。';
      } else if (prompt === '/help' || (!prompt && !imageAttachments(message).length)) {
        reply = (privateChat ? '这是独立私聊，直接发送问题即可，无需@。' : '用法：@机器人 你的问题。') + '/ping 检查在线状态；/memory 查看记忆状态；/reset 或“清空记忆”重置上下文。' +
          (config.contextTurns ? `${shared ? '本群共享' : '每位成员分别保存'}${config.contextPersist ? '长期记忆' : '内存记忆'}，较早内容${config.contextCompact ? '自动整理成摘要' : '按窗口裁剪'}。` : '当前已关闭上下文。') +
          '\n识图：图片和 @ 问题须在同一条消息。表情列表；表情来源；表情 名称（不填则随机）；存表情 名称＋PNG/JPG（仅群主/管理员）；搜图 关键词；发图 HTTPS图片直链。上述指令均需 @。' +
          (config.autoMemeEnabled ? '\n轻松聊天时会偶尔从本群表情库选图搭配回复。' : '') +
          (community && !privateChat ? '\n设置称呼 名字：保存常用称呼；我是谁：查看当前身份。' : '') +
          (config.webSearchEnabled ? '\n查资料 公开问题：联网查询并附来源；最新信息等问题也会尝试查询。' : '') +
          (config.styleEnabled ? '\n语气状态：查看本地学习；重置语气（仅管理员）。' : '') +
          (config.groupChatEnabled && !privateChat ? '\n群聊记录状态：查看最近群聊的本地记录；清空群聊记录（仅管理员）。普通消息只本地记录和学习，被@才交给模型回复。' : '') +
          (config.idleEnabled && !privateChat ? '\n冷群聊天 状态／开／关：查看或控制偶尔主动发言，开关仅管理员。' : '') +
          (config.trendsEnabled ? '\n热梗列表／热梗状态／更新热梗：查看或按统一限额更新网络表达。' : '') + '\n媒体自检：检查emoji和表情图片。';
        if (privateChat) reply = reply.replaceAll('同群共享', '本人独立').replaceAll('本群共享', '本人独立').replaceAll('每位成员分别保存', '本人独立保存')
          .replace('（仅群主/管理员）', '（仅保存到你自己的私聊库）').replace('上述指令均需 @。', '私聊无需@。').replaceAll('@机器人 ', '');
      } else if (prompt === '/memory' || prompt === '记忆状态') {
        const status = memory.stats(conversationKey);
        reply = `${status.persistent ? '长期记忆已启用，重启后可恢复。' : '当前使用临时内存记忆。'}摘要 ${status.summaryChars} 字，原话 ${status.turns} 轮，已压缩 ${status.compactions} 次。` +
          (status.dirty ? '有记录尚未成功保存到磁盘，请查看服务日志。' : '');
      } else {
        const match = /^(?:\/(?:meme|save-meme|memes|image|image-search)|表情|存表情|表情列表|搜图|发图)(?:\s+(.*))?$/u.exec(prompt);
        const command = match ? prompt.split(/\s/)[0] : undefined;
        const argument = match?.[1]?.trim() || '';
        if (match) {
          imageOperation = true;
          if (!config.imageSendEnabled) throw new MediaError('image_send_disabled', '发图功能当前已关闭。');
          if (config.mock) throw new MediaError('mock_media', '离线演示不会下载或发送图片，请在真实接入后使用图片功能。');
          if (['表情列表', '/memes'].includes(command)) {
            const names = media.list(message.group_openid);
            reply = names.length ? `本群表情：${names.join('、')}。发送“表情 名称”调用，名称留空则随机。`
              : '本群还没有表情包。请群主或管理员发送“存表情 名称”，并在同一条 @ 消息里附上 PNG/JPG。';
            const sources = media.sources?.(message.group_openid) || [];
            if (sources.length) reply += `\n含${sources[0].pack}／${sources[0].author}表情；发送“表情来源”查看作者和许可。`;
          } else if (['存表情', '/save-meme'].includes(command)) {
            reply = await media.save(message.group_openid, argument, message);
          } else if (['表情', '/meme'].includes(command)) mediaReply = media.meme(message.group_openid, argument);
          else if (['搜图', '/image-search'].includes(command)) {
            if (!config.imageSearchEnabled) throw new MediaError('image_search_disabled', '联网搜图当前已关闭。');
            mediaReply = await media.search(argument);
          } else mediaReply = await media.fromURL(argument);
          if (mediaReply) fileInfo = await transport.uploadImage(target, mediaReply.image);
        } else {
          const attachments = imageAttachments(message);
          if (attachments.length && !config.visionEnabled) throw new MediaError('vision_disabled', '识图功能当前已关闭。');
          if (attachments.length && config.mock) throw new MediaError('mock_media', '离线演示不会下载图片，请在真实接入后测试识图。');
          imageOperation = attachments.length > 0;
          const images = attachments.length ? await media.images(message) : [];
          const question = prompt || '请描述这些图片，并解释其中值得注意的内容。';
          if (privateChat || !config.groupChatEnabled) style.observe(message.group_openid, message.author.member_openid, privacy.text(question));
          const history = config.contextCompact ? await memory.prepare(conversationKey, summarize) : memory.get(conversationKey);
          const groupChatContext = !privateChat ? groupChat.material(message.group_openid, question,
            { excludeMessageId: message.id, currentMember: message.author.member_openid }) : undefined;
          const communityContext = !privateChat ? community?.context(message.group_openid, observed,
            [...history, ...(groupChatContext?.recent || []).map(item => ({ name: item.speaker, content: '' }))]) : undefined;
          let web;
          const query = selectWebQuery(question, config, communityContext);
          if (query && search) {
            try {
              const results = await search(query);
              web = { status: results.length ? 'ok' : 'empty', results };
              log('info', 'web_search_done', { reason: results.length ? 'results_found' : 'no_results' });
            } catch (error) {
              web = { status: 'unavailable', results: [] };
              log('warn', 'web_search_failed', { reason: error instanceof UpstreamError ? error.reason : 'search_unavailable', status: error.status || 0 });
            }
          }
          reactionLease = reactions.acquire(message.group_openid, () => media.catalog(message.group_openid), question);
          const answer = await ask(question, history, speaker, images, { ...(reactionLease ? { memes: reactionLease.catalog } : {}),
            ...(communityContext ? { community: communityContext } : {}), ...(web ? { web } : {}), ...(privateChat ? { privateChat: true } : {}),
            ...(config.styleEnabled ? { style: style.hint(message.group_openid, message.author.member_openid) } : {}),
            ...(config.trendsEnabled ? { slang: trends.material(question) } : {}),
            ...(groupChatContext ? { groupChat: groupChatContext } : {}),
            ...(idle.context(message.group_openid) ? { idleContext: idle.context(message.group_openid) } : {}) });
          reply = typeof answer === 'string' ? answer : answer?.reply;
          replySources = Array.isArray(answer?.sources) ? answer.sources : [];
          if (typeof reply !== 'string' || !reply.trim()) throw new UpstreamError('deepseek', 'empty_reply');
          reactionName = reactionLease?.catalog.some(item => item.name === answer?.meme) ? answer.meme : undefined;
          rememberedPrompt = images.length ? `${question}\n[本轮附带 ${images.length} 张图片；原图未保存，仅保留问题和当时的文字分析]` : prompt;
          remember = true;
        }
      }
    } catch (error) {
      mediaReply = undefined;
      log('error', error instanceof MemoryStorageError ? 'memory_unavailable' : imageOperation || error instanceof MediaError ? 'media_failed' : 'deepseek_failed', {
        reason: error instanceof UpstreamError || error instanceof MemoryStorageError || error instanceof MediaError ? error.reason : 'internal_error',
        status: error.status || 0, api_code: error.apiCode, finish_reason: error.finishReason, tokens: error.tokens
      });
      reply = error instanceof MediaError ? error.publicMessage : error instanceof MemoryStorageError
        ? '长期记忆暂时不可用，原记录会保留，请稍后再试或检查服务日志。'
        : imageOperation ? '识图或图片服务暂时不可用，请稍后重新 @ 我。' : 'AI 服务暂时不可用，请稍后重新 @ 我。';
    }
    try {
      if (privateChat && !remember && typeof reply === 'string') reply = reply.replaceAll('本群', '本次私聊').replaceAll('@机器人 ', '')
        .replaceAll('同一条 @ 消息', '同一条消息').replaceAll('请稍后重新 @ 我', '请稍后重新发送');
      if (mediaReply) {
        await transport.sendImage(target, message.id, fileInfo);
        log('info', 'image_sent', { elapsed_ms: now() - started });
        if (mediaReply.caption) await transport.send(target, message.id, limitReply(privacy.text(mediaReply.caption), config.maxReply), 2);
        return;
      }
      reply = privacy.text(reply);
      replySources = replySources.filter(item => privacy.text(item.url) === item.url).map(item => privacy.value(item));
      let deliveredReply = formatSourcedReply(reply, replySources, config.maxReply, limitReply);
      try { await transport.send(target, message.id, deliveredReply); }
      catch (error) {
        // 平台明确拒绝URL代表本条未送达；仅此业务码允许移除链接后尝试同一条回复。
        if (!replySources.length || error.apiCode !== 40054010) throw error;
        deliveredReply = formatSourcedReply(reply, replySources, config.maxReply, limitReply, false);
        await transport.send(target, message.id, deliveredReply);
      }
      // 只记住群成员实际看到的成功问答，故障提示和未送达回答不进入上下文。
      if (remember) {
        try { memory.append(conversationKey, rememberedPrompt, deliveredReply, speaker); }
        catch (error) { log('error', 'memory_persist_failed', { reason: error.reason || 'write_failed' }); }
      }
      log('info', privateChat ? 'dm_reply_sent' : 'reply_sent', { elapsed_ms: now() - started });
      if (reactionName && now() - Date.parse(message.timestamp) < 270000 && (mediaSelfTest || (remember && reactionLease?.attempt(reactionName)))) {
        try {
          const image = media.meme(message.group_openid, reactionName).image;
          const info = await transport.uploadImage(target, image);
          await transport.sendImage(target, message.id, info, 2);
          log('info', mediaSelfTest ? 'media_test_sent' : 'auto_meme_sent', { elapsed_ms: now() - started });
        } catch (error) {
          // 文字已经送达并保存；可选表情失败不影响回答，也不补发错误消息。
          log('warn', mediaSelfTest ? 'media_test_failed' : 'auto_meme_failed', { reason: error instanceof UpstreamError || error instanceof MediaError ? error.reason : 'image_unavailable',
            status: error.status || 0, api_code: error.apiCode, trace_id: error.trace });
        }
      }
    } catch (error) {
      log('error', 'qq_reply_failed', {
        reason: error instanceof UpstreamError ? error.reason : 'internal_error',
        status: error.status || 0, api_code: error.apiCode, trace_id: error.trace
      });
    } finally { reactionLease?.release(); }
  }

  return {
    setSelfUser(user) { groupAt.setSelf(user); },
    get groupStatus() { return { ...groupEvents, self_identified: groupAt.selfKnown }; },
    get groupChatStatus() { return { ...groupChat.summary(), reply_only_when_at: !!config.groupAtOnly,
      idle_topic_exception: !!config.idleEnabled && config.idleForceAfterMs > 0 }; },
    async confirmIdleFeed(isReady = () => true) {
      if (closing || !config.idleEnabled || !config.idleForceAfterMs || config.mock || typeof qq.groupState !== 'function') return;
      for (const group of config.groups) {
        try {
          const state = await qq.groupState(group);
          if (closing || !isReady()) return;
          if (state.receiveAll && state.allowProactive) {
            idle.confirmFull(group);
            log('info', 'idle_permissions_confirmed', { reason: 'all_messages_and_proactive_allowed' });
          } else log('warn', 'idle_permissions_unconfirmed', { reason: 'requires_all_messages_and_proactive' });
        } catch (error) { log('warn', 'idle_permissions_unconfirmed', { reason: error instanceof UpstreamError ? error.reason : 'state_unavailable', status: error.status || 0 }); }
      }
    },
    async announceStartup(isReady = () => true) {
      if (closing || config.groupAtOnly || !config.startupEnabled || config.mock || typeof qq.sendActive !== 'function') return;
      for (const group of config.groups) {
        const lease = startup.reserve(group);
        if (!lease) continue;
        while (!closing && tasks.size >= config.concurrency) await Promise.race([...tasks]);
        if (closing) return;
        const task = Promise.resolve().then(async () => {
          try {
            const text = limitReply(privacy.text(await startup.welcome()), config.maxReply);
            if (closing || !isReady()) return;
            const result = await qq.sendActive(group, text, () => !closing && isReady());
            if (!result?.skipped) { startup.finish(lease); log('info', 'startup_greeting_sent'); }
          } catch (error) { log('warn', 'startup_greeting_failed', { reason: error instanceof UpstreamError ? error.reason : 'send_unavailable', status: error.status || 0, api_code: error.apiCode }); }
        }).finally(() => tasks.delete(task));
        tasks.add(task); await task;
      }
    },
    pauseIdleFeed() { idle.disconnect(); },
    submit(payload) {
      const full = payload?.t === 'GROUP_MESSAGE_CREATE';
      const privateChat = payload?.t === 'C2C_MESSAGE_CREATE';
      if (payload?.op !== 0 || (payload.t !== 'GROUP_AT_MESSAGE_CREATE' && !privateChat && !full)) return skip('unsubscribed_event');
      if (privateChat && !config.dmEnabled) return skip('dm_disabled');
      let message = payload.d;
      if (privateChat) {
        const user = message?.author?.user_openid;
        if (!identifier(user)) return skip('invalid_message');
        if (!config.dmAllowAll && !config.dmUsers.has(user)) return skip('dm_denied');
        // 私聊不接受伪造的群身份/群目标；单独命名空间保证记忆与素材隔离。
        message = { ...message, privateChat: true, group_openid: `dm:${user}`, mentions: undefined,
          author: { member_openid: user, bot: message.author.bot, username: message.author.username } };
      } else if (message) message = { ...message, privateChat: false };
      if (!message || !identifier(message.id) || !identifier(message.group_openid) ||
          !identifier(message.author?.member_openid) || typeof message.content !== 'string') return skip('invalid_message');
      if (message.author.bot === true) return skip('bot_message');
      const timestamp = now();
      const sentAt = Date.parse(message.timestamp);
      if (!Number.isFinite(sentAt) || timestamp - sentAt > 240000 || sentAt - timestamp > 60000) return skip('stale_message');
      if (!privateChat && !config.allowAllGroups && !config.groups.has(message.group_openid)) {
        log('warn', 'group_denied', { group_openid: message.group_openid });
        return skip('group_denied');
      }
      let fullAt = false;
      if (full) {
        groupEvents.full_received++;
        const detection = groupAt.detect(message);
        if (detection.targeted) {
          fullAt = true; groupEvents.full_at_recognized++;
          message = { ...message, content: detection.content, mentions: detection.mentions };
          log('info', 'full_group_at_received', { reason: detection.reason });
        } else if (detection.reason === 'unresolved_bot_mention') {
          groupEvents.unresolved_bot_mentions++;
          log('info', 'full_bot_mention_unresolved');
        }
      } else if (!privateChat) groupEvents.native_at_received++;
      // 普通消息可在本机记录文字和语气；不会读图、执行命令、联网或唤醒模型。
      // 与 @ 事件分别去重，避免两种事件以任意顺序到达时吞掉正常回复。
      const activityKey = JSON.stringify([message.group_openid, message.id]);
      prune(activitySeen, timestamp);
      const newActivity = !activitySeen.has(activityKey);
      if (newActivity) {
        if (activitySeen.size >= config.maxEntries) activitySeen.delete(activitySeen.keys().next().value);
        activitySeen.set(activityKey, timestamp + config.dedupTtl);
        if (!privateChat) idle.activity(message.group_openid, { full });
      } else if (full) idle.confirmFull(message.group_openid);
      if (newActivity && !privateChat && !closing && config.groupChatEnabled && (!config.users.size || config.users.has(message.author.member_openid))) {
        if (groupChat.observe(message.group_openid, message)) {
          style.observe(message.group_openid, message.author.member_openid, privacy.text(message.content));
          if (full && !fullAt) community?.observe(message.group_openid, message.author, message.mentions);
        }
      }
      if (full && !fullAt) return { kind: 'observed' };
      if (!privateChat && config.users.size && !config.users.has(message.author.member_openid)) return skip('user_denied');
      const prompt = message.content.trim();
      if (Array.from(prompt).length > config.maxInput) return skip('input_too_long');
      const messageKey = JSON.stringify([message.group_openid, message.id]);
      const userKey = JSON.stringify([message.group_openid, message.author.member_openid]);
      const conversationKey = privateChat ? JSON.stringify(['private', message.author.member_openid]) : config.contextScope === 'group' ? JSON.stringify([message.group_openid]) : userKey;
      prune(seen, timestamp);
      prune(cooldown, timestamp);
      recent = recent.filter(time => timestamp - time < 60000);
      if (seen.has(messageKey)) return skip('duplicate');
      if (closing || tasks.size >= config.concurrency || seen.size >= config.maxEntries || activeIdleGroups.has(message.group_openid)) return { kind: 'busy' };
      if (cooldown.has(userKey) || recent.length >= config.perMinute) return skip('rate_limited');
      if (config.contextTurns && activeConversations.has(conversationKey)) return { kind: 'busy' };
      // 先占位再 ACK，同进程中的重复推送不会再次消耗 API 额度。
      seen.set(messageKey, timestamp + config.dedupTtl);
      cooldown.set(userKey, timestamp + config.cooldownMs);
      recent.push(timestamp);
      activeConversations.add(conversationKey);
      if (privateChat) { privateReceived++; log('info', 'dm_message_received'); }
      else groupEvents.at_accepted++;
      const task = Promise.resolve().then(() => respond(message, prompt, conversationKey)).catch(() => {
        log('error', 'task_failed', { reason: 'internal_error' });
      }).finally(() => { tasks.delete(task); activeConversations.delete(conversationKey); });
      tasks.add(task);
      return { kind: 'accepted' };
    },
    async tickTrends() {
      if (closing || !config.trendsEnabled || config.mock || tasks.size) return;
      const task = trends.refresh().finally(() => tasks.delete(task));
      tasks.add(task); await task;
    },
    get trendStatus() { return trends.summary(); },
    get privateStatus() { return { enabled: !!config.dmEnabled, received: privateReceived }; },
    async tickIdle() {
      idle.heartbeat();
      if (closing || (config.groupAtOnly && !config.idleForceAfterMs) || !config.idleEnabled || config.mock || tasks.size || typeof qq.sendActive !== 'function') return;
      // 仅显式获准的群参与主动发言；ALLOW_ALL_GROUPS 不扩散定时消息。
      for (const group of config.groups) {
        const lease = idle.reserve(group);
        if (!lease) continue;
        activeIdleGroups.add(group);
        const task = Promise.resolve().then(async () => {
          if (closing || !idle.canSend(lease)) { idle.finish(lease, 'canceled'); return; }
          try {
            let text = limitReply(privacy.text(await publicTopics.compose(lease.text)), config.maxReply);
            // 联网等待中有人说话、离线、管理员暂停或跨过夜间边界，取消本次冷群发言。
            if (closing || !idle.canSend(lease)) { idle.finish(lease, 'canceled'); return; }
            lease.text = text;
            let result;
            try { result = await qq.sendActive(group, text, () => !closing && idle.canSend(lease)); }
            catch (error) {
              // 明确拒绝链接才移除URL重试；结果不明、其他权限错误仍不重试。
              if (error.apiCode !== 40054010 || !/https?:\/\//u.test(text)) throw error;
              text = text.replace(/https?:\/\/[^\s<>]+/gu, '（链接被QQ限制）');
              lease.text = text;
              result = await qq.sendActive(group, text, () => !closing && idle.canSend(lease));
            }
            const outcome = result?.skipped ? 'canceled' : 'sent';
            idle.finish(lease, outcome);
            log('info', outcome === 'sent' ? 'idle_message_sent' : 'idle_message_canceled');
          } catch (error) {
            idle.finish(lease, 'failed');
            log('warn', 'idle_message_failed', { reason: error instanceof UpstreamError ? error.reason : 'send_unavailable', status: error.status || 0, api_code: error.apiCode });
          }
        }).finally(() => { tasks.delete(task); activeIdleGroups.delete(group); });
        tasks.add(task);
        await task;
        break;
      }
    },
    get idleStatus() { return idle.summary(); },
    async drain() {
      await Promise.allSettled([...tasks]);
      try { memory.flushAll(); } catch (error) { log('error', 'memory_persist_failed', { reason: error.reason || 'write_failed' }); }
    },
    stop() { closing = true; },
    get inflight() { return tasks.size; }
  };
}
