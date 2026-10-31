export const MOCK_SECRET = 'local-demo-secret-never-use-in-production';

function number(env, name, fallback, min, max) {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}～${max} 的整数`);
  }
  return value;
}

function list(value) {
  return new Set((value || '').split(',').map(x => x.trim()).filter(Boolean));
}

function secureBase(env, name, fallback) {
  const url = new URL(env[name] || fallback);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} 必须是无凭证、无查询参数的 HTTPS 地址`);
  }
  return url.href.replace(/\/$/, '');
}

export function loadConfig(env = process.env, { mock = false } = {}) {
  if (!mock) {
    for (const name of ['QQ_APP_ID', 'QQ_APP_SECRET', 'DEEPSEEK_API_KEY']) {
      if (!env[name]?.trim()) throw new Error(`缺少 ${name}，请在本地 .env 填写`);
    }
    if (!['true', 'false', undefined, ''].includes(env.ALLOW_ALL_GROUPS)) {
      throw new Error('ALLOW_ALL_GROUPS 只能是 true 或 false');
    }
  }
  if (env.CONTEXT_SCOPE && !['group', 'member'].includes(env.CONTEXT_SCOPE)) {
    throw new Error('CONTEXT_SCOPE 只能是 group 或 member');
  }
  if (env.IMAGE_SEARCH_PROVIDER && !['bing', 'commons'].includes(env.IMAGE_SEARCH_PROVIDER)) {
    throw new Error('IMAGE_SEARCH_PROVIDER 只能是 bing 或 commons');
  }
  for (const name of ['CONTEXT_PERSIST', 'CONTEXT_AUTO_COMPACT', 'VISION_ENABLED', 'IMAGE_SEND_ENABLED', 'IMAGE_SEARCH_ENABLED', 'AUTO_MEME_ENABLED', 'COMMUNITY_ENABLED', 'WEB_SEARCH_ENABLED', 'WEB_SEARCH_AUTOMATIC', 'STYLE_ENABLED', 'GROUP_CHAT_ENABLED', 'GROUP_AT_ONLY', 'IDLE_CHAT_ENABLED', 'IDLE_NEWS_ENABLED', 'DM_ENABLED', 'DM_ALLOW_ALL_USERS', 'TRENDS_ENABLED', 'STARTUP_GREETING_ENABLED', 'STARTUP_NEWS_ENABLED']) {
    if (!['true', 'false', undefined, ''].includes(env[name])) throw new Error(`${name} 只能是 true 或 false`);
  }
  if (env.QQ_TRANSPORT && !['webhook', 'websocket'].includes(env.QQ_TRANSPORT)) throw new Error('QQ_TRANSPORT 只能是 webhook 或 websocket');
  const ownerAliases = [...list(env.OWNER_ALIASES)];
  const ownerPossibleAliases = [...list(env.OWNER_POSSIBLE_ALIASES)];
  const privateNames = [...list(env.PRIVATE_NAMES)];
  const ownerDisplayName = env.OWNER_DISPLAY_NAME?.trim() || '主人';
  for (const name of [...ownerAliases, ...ownerPossibleAliases, ...privateNames, ownerDisplayName]) {
    if (Array.from(name).length > 24 || /[<>\u0000-\u001f\u007f]/u.test(name)) throw new Error('OWNER_ALIASES 必须是每项不超过24字的普通称呼');
  }
  if (ownerAliases.length + ownerPossibleAliases.length > 20) throw new Error('OWNER_ALIASES 必须不超过20项');
  if (privateNames.length > 20 || privateNames.some(name => ownerDisplayName.normalize('NFKC').includes(name.normalize('NFKC')))) throw new Error('PRIVATE_NAMES 必须不超过20项且不能包含公开称呼');
  const idleStartHour = number(env, 'IDLE_START_HOUR', 9, 0, 23);
  const idleEndHour = number(env, 'IDLE_END_HOUR', 22, 1, 24);
  if (idleStartHour >= idleEndHour) throw new Error('IDLE_END_HOUR 必须大于 IDLE_START_HOUR');
  const groupAtOnly = !mock && env.GROUP_AT_ONLY === 'true';
  const idleForceAfterMs = number(env, 'IDLE_FORCE_AFTER_HOURS', 0, 0, 24) * 3600000;
  const idleAllowed = !groupAtOnly || idleForceAfterMs > 0;
  return {
    mock,
    transport: mock ? 'webhook' : env.QQ_TRANSPORT || 'webhook',
    ownerAliases, ownerPossibleAliases, privateNames, ownerDisplayName,
    groupAtOnly,
    startupEnabled: !mock && !groupAtOnly && env.STARTUP_GREETING_ENABLED === 'true',
    startupNewsEnabled: !mock && !groupAtOnly && env.STARTUP_NEWS_ENABLED === 'true',
    startupDataDir: env.STARTUP_DATA_DIR || 'data/startup',
    startupCooldownMs: number(env, 'STARTUP_GREETING_COOLDOWN_MINUTES', 10, 5, 1440) * 60000,
    startupNewsRefreshMs: number(env, 'STARTUP_NEWS_REFRESH_HOURS', 12, 6, 168) * 3600000,
    appId: mock ? 'demo-app' : env.QQ_APP_ID.trim(),
    appSecret: mock ? MOCK_SECRET : env.QQ_APP_SECRET.trim(),
    deepseekKey: mock ? '' : env.DEEPSEEK_API_KEY.trim(),
    deepseekBase: mock ? '' : secureBase(env, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    qqBase: mock ? '' : secureBase(env, 'QQ_API_BASE_URL', 'https://api.bot.qq.com'),
    model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    systemPrompt: env.SYSTEM_PROMPT || '你是 QQ 群里的 AI 助手。用简洁中文回答，尽量控制在 500 字以内。',
    host: mock ? '127.0.0.1' : (env.HOST || '127.0.0.1'),
    port: number(env, 'PORT', 3000, 1, 65535),
    groups: mock ? new Set(['demo-group']) : list(env.ALLOWED_GROUP_IDS),
    users: mock ? new Set() : list(env.ALLOWED_USER_IDS),
    allowAllGroups: !mock && env.ALLOW_ALL_GROUPS === 'true',
    dmEnabled: !mock && env.DM_ENABLED === 'true',
    dmAllowAll: !mock && env.DM_ALLOW_ALL_USERS === 'true',
    dmUsers: list(env.ALLOWED_DM_USER_IDS),
    trendsEnabled: !mock && env.TRENDS_ENABLED === 'true',
    trendsDataDir: env.TRENDS_DATA_DIR || 'data/trends',
    trendsRefreshMs: number(env, 'TRENDS_REFRESH_HOURS', 6, 6, 168) * 3600000,
    trendsMaxTerms: number(env, 'TRENDS_MAX_TERMS', 60, 12, 100),
    cooldownMs: number(env, 'USER_COOLDOWN_MS', 5000, 0, 600000),
    perMinute: number(env, 'MAX_REQUESTS_PER_MINUTE', 20, 1, 1000),
    concurrency: number(env, 'MAX_CONCURRENT_REQUESTS', 2, 1, 20),
    maxInput: number(env, 'MAX_INPUT_CHARS', 2000, 1, 10000),
    maxReply: number(env, 'MAX_REPLY_CHARS', 1200, 100, 2000),
    maxTokens: number(env, 'DEEPSEEK_MAX_TOKENS', 600, 1, 4096),
    deepseekTimeout: number(env, 'DEEPSEEK_TIMEOUT_MS', 25000, 1000, 120000),
    visionEnabled: env.VISION_ENABLED !== 'false',
    visionModel: env.VISION_MODEL?.trim() || env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    maxImages: number(env, 'MAX_IMAGES_PER_MESSAGE', 3, 1, 5),
    imageMaxBytes: number(env, 'IMAGE_MAX_BYTES', 4000000, 1024, 4500000),
    imageTimeout: number(env, 'IMAGE_TIMEOUT_MS', 15000, 1000, 30000),
    imageSendEnabled: env.IMAGE_SEND_ENABLED !== 'false',
    imageSearchEnabled: env.IMAGE_SEARCH_ENABLED !== 'false',
    imageSearchProvider: env.IMAGE_SEARCH_PROVIDER || 'bing',
    memeDataDir: env.MEME_DATA_DIR || 'data/memes',
    maxMemesPerGroup: number(env, 'MAX_MEMES_PER_GROUP', 100, 1, 500),
    autoMemeEnabled: !mock && env.AUTO_MEME_ENABLED !== 'false',
    autoMemePercent: number(env, 'AUTO_MEME_CHANCE_PERCENT', 25, 0, 100),
    autoMemeCooldownMs: number(env, 'AUTO_MEME_COOLDOWN_SECONDS', 300, 0, 86400) * 1000,
    autoMemeMaxOptions: number(env, 'AUTO_MEME_MAX_OPTIONS', 30, 1, 100),
    communityEnabled: !mock && env.COMMUNITY_ENABLED === 'true',
    communityDataDir: env.COMMUNITY_DATA_DIR || 'data/community',
    communityMaxMembers: number(env, 'COMMUNITY_MAX_MEMBERS', 500, 1, 2000),
    webSearchEnabled: !mock && env.WEB_SEARCH_ENABLED === 'true',
    webSearchAutomatic: env.WEB_SEARCH_AUTOMATIC !== 'false',
    webSearchTimeout: number(env, 'WEB_SEARCH_TIMEOUT_MS', 10000, 1000, 30000),
    styleEnabled: !mock && env.STYLE_ENABLED === 'true',
    styleDataDir: env.STYLE_DATA_DIR || 'data/style',
    groupChatEnabled: !mock && env.GROUP_CHAT_ENABLED === 'true',
    groupChatDataDir: env.GROUP_CHAT_DATA_DIR || 'data/group-chat',
    groupChatMaxMessages: number(env, 'GROUP_CHAT_MAX_MESSAGES', 120, 20, 500),
    groupChatMaxChars: number(env, 'GROUP_CHAT_MAX_CHARS', 30000, 4000, 100000),
    groupChatTtlMs: number(env, 'GROUP_CHAT_TTL_HOURS', 168, 1, 720) * 3600000,
    groupChatContextChars: number(env, 'GROUP_CHAT_CONTEXT_CHARS', 2200, 600, 6000),
    groupChatContextMessages: number(env, 'GROUP_CHAT_CONTEXT_MESSAGES', 12, 3, 24),
    idleForceAfterMs,
    idleEnabled: !mock && idleAllowed && env.IDLE_CHAT_ENABLED === 'true',
    idleDataDir: env.IDLE_DATA_DIR || 'data/idle',
    idleNewsEnabled: !mock && idleAllowed && env.WEB_SEARCH_ENABLED === 'true' && env.IDLE_NEWS_ENABLED === 'true',
    idleNewsRefreshMs: number(env, 'IDLE_NEWS_REFRESH_HOURS', 12, 12, 168) * 3600000,
    idleQuietMs: number(env, 'IDLE_QUIET_MINUTES', 60, 30, 1440) * 60000,
    idleCooldownMs: number(env, 'IDLE_COOLDOWN_HOURS', 4, 1, 168) * 3600000,
    idleDailyMax: number(env, 'IDLE_DAILY_MAX', 2, 1, 5),
    idleChancePercent: number(env, 'IDLE_CHANCE_PERCENT', 25, 0, 100),
    idleCheckMs: number(env, 'IDLE_CHECK_MINUTES', 15, 5, 60) * 60000,
    idleStartHour, idleEndHour,
    contextScope: env.CONTEXT_SCOPE || 'group',
    contextTurns: number(env, 'CONTEXT_MAX_TURNS', 10, 0, 20),
    contextTtlMs: number(env, 'CONTEXT_TTL_MINUTES', 0, 0, 120) * 60000,
    contextMaxChars: number(env, 'CONTEXT_MAX_CHARS', 12000, 1000, 40000),
    contextMaxSessions: number(env, 'CONTEXT_MAX_SESSIONS', 500, 1, 2000),
    contextPersist: !mock && env.CONTEXT_PERSIST !== 'false',
    contextCompact: !mock && env.CONTEXT_AUTO_COMPACT !== 'false',
    contextDataDir: env.CONTEXT_DATA_DIR || 'data/memory',
    contextRecentTurns: number(env, 'CONTEXT_RECENT_TURNS', 4, 1, 10),
    contextSummaryMaxChars: number(env, 'CONTEXT_SUMMARY_MAX_CHARS', 2400, 200, 4000),
    contextSummaryTokens: number(env, 'CONTEXT_SUMMARY_MAX_TOKENS', 1000, 100, 2000),
    contextSummaryModel: env.CONTEXT_SUMMARY_MODEL?.trim() || env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    contextCompactBatchChars: number(env, 'CONTEXT_COMPACT_BATCH_CHARS', 24000, 4000, 80000),
    contextCompactRetryMs: number(env, 'CONTEXT_COMPACT_RETRY_SECONDS', 60, 1, 600) * 1000,
    contextPendingMaxChars: number(env, 'CONTEXT_MAX_PENDING_CHARS', 120000, 40000, 1000000),
    contextPendingMaxTurns: 200,
    signatureMaxAge: 300,
    dedupTtl: 600000,
    maxEntries: 10000,
    maxBodyBytes: 65536
  };
}
