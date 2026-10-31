import { loadConfig } from '../src/config.js';

try {
  const config = loadConfig();
  console.log('必需环境变量已填写；这只检查配置格式，不会调用 QQ 或 DeepSeek。');
  console.log(`QQ接入：${config.transport}；上线招呼${config.startupEnabled ? '开启，短时重启防刷屏' : '关闭'}；主人称呼：${config.ownerAliases.length}项确定、${config.ownerPossibleAliases.length}项可能（不显示内容）`);
  console.log(`群访问策略：${config.allowAllGroups ? '允许所有已加入的群' : `白名单 ${config.groups.size} 个群`}`);
  console.log(`成员访问策略：${config.users.size ? `白名单 ${config.users.size} 个成员` : '允许已获准群中的所有成员'}`);
  console.log(`私聊：${config.dmEnabled ? `开启，${config.dmAllowAll ? '允许QQ平台获准的私聊用户' : `白名单${config.dmUsers.size}位用户`}，与群聊独立记忆；需订阅C2C_MESSAGE_CREATE` : '关闭'}`);
  console.log(`网络热梗库：${config.trendsEnabled ? `开启，每${config.trendsRefreshMs / 3600000}小时最多联网核对一次，聊天复用缓存` : '关闭'}`);
  console.log(`上下文：${config.contextTurns ? `${config.contextScope === 'group' ? '同群共享' : '成员独立'}，${config.contextPersist ? '磁盘持久化' : '仅内存'}，${config.contextTtlMs ? `${config.contextTtlMs / 60000} 分钟过期` : '不自动过期'}` : '关闭'}`);
  if (config.contextTurns) console.log(`历史整理：${config.contextCompact ? `自动摘要，保留最近 ${config.contextRecentTurns} 轮原话` : '关闭，按窗口裁剪'}`);
  console.log(`图片：识图${config.visionEnabled ? '开启' : '关闭'}，发图${config.imageSendEnabled ? '开启' : '关闭'}，搜图${config.imageSearchEnabled ? config.imageSearchProvider : '关闭'}；单条最多 ${config.maxImages} 张，单图 ${config.imageMaxBytes} 字节`);
  console.log(`自主表情：${config.autoMemeEnabled ? `开启，${config.autoMemePercent}%选图机会，同群间隔至少${config.autoMemeCooldownMs / 1000}秒` : '关闭'}`);
  console.log(`社群身份档案：${config.communityEnabled ? '开启' : '关闭'}；公开资料搜索：${config.webSearchEnabled ? '开启' : '关闭'}`);
  console.log(`本地语气学习：${config.styleEnabled ? config.groupChatEnabled ? '开启，从普通群聊和@对话学习，不新增训练调用' : '开启，只统计@对话，不新增模型调用' : '关闭'}`);
  console.log(`被动群聊记录：${config.groupChatEnabled ? `开启，每群最近${config.groupChatMaxMessages}条、最多${config.groupChatTtlMs / 3600000}小时，@时最多携带${config.groupChatContextChars}字参考` : '关闭'}；群聊回复：${config.groupAtOnly ? config.idleEnabled && config.idleForceAfterMs ? '正常只回应@，确定性冷群话题例外；上线招呼关闭' : '只在被@时，禁止冷群和上线招呼' : '按功能开关'}`);
  console.log(`姓名隐私：${config.privateNames.length ? '已配置，模型文字资料与外发文字使用公开称呼' : '未配置'}；冷群公开话题：${config.idleNewsEnabled ? '开启，共享12小时以上搜索缓存' : '关闭'}`);
  console.log(`冷群聊天：${config.idleEnabled ? config.idleForceAfterMs ? `开启，完整在线观察连续${config.idleForceAfterMs / 3600000}小时无人发言后确定触发，全天生效、一次冷场一次；会核验QQ接收及主动权限` : `开启，需收到普通群消息；北京时间${config.idleStartHour}～${config.idleEndHour}点，至少安静${config.idleQuietMs / 60000}分钟，每天最多${config.idleDailyMax}条` : '关闭'}`);
  if (!config.allowAllGroups && !config.groups.size) console.log('提示：当前拒绝所有群，请按 README 的首次群授权步骤填写名单。');
} catch {
  console.error('配置不完整或格式有误。请检查 .env 中的必需变量、HTTPS 地址及整数范围；不会显示任何密钥。');
  process.exitCode = 1;
}
