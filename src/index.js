import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { createLogger } from './log.js';
import { MemoryStorageError } from './context.js';
import { createGateway } from './gateway.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

const log = createLogger();
let config;
try {
  config = loadConfig(process.env, { mock: process.argv.includes('--mock') });
} catch (error) {
  // 配置错误来自本地校验；URL 构造器的错误消息可能含用户输入，因此只显示已知错误。
  const safe = /^(缺少 |[A-Z_]+ (必须|只能))/.test(error.message) ? error.message : '配置地址格式不正确，请检查 .env';
  process.stderr.write(safe + '\n');
  process.exit(1);
}
let server;
let bot;
let idleTimer;
let controlTimer;
let gateway;
let qq;
try { ({ server, bot, qq } = buildServer(config, { gatewayStatus: () => gateway?.status || { state: config.transport === 'websocket' ? 'starting' : 'not_used' } })); }
catch (error) {
  log('error', 'startup_failed', { reason: error instanceof MemoryStorageError ? error.reason : 'startup_error' });
  process.exit(1);
}
server.on('error', error => {
  log('error', 'listen_failed', { reason: error.code === 'EADDRINUSE' ? 'port_in_use' : 'listen_error' });
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  log('info', 'server_started', { host: config.host, port: config.port, mode: config.mock ? 'mock' : 'live' });
  if (!config.allowAllGroups && !config.groups.size) log('warn', 'all_groups_denied');
  if (config.transport === 'websocket' && !config.mock) {
    gateway = createGateway(config, { bot, access: () => qq.gatewayInfo(), log,
      onReady: async () => {
        await bot.confirmIdleFeed(() => gateway.status.state === 'ready');
        await bot.announceStartup(() => gateway.status.state === 'ready');
      } });
    gateway.start();
  } else if (config.startupEnabled && !config.mock) void bot.announceStartup();
  if (config.idleEnabled) log('info', 'idle_waiting_for_full_feed');
  if (config.trendsEnabled) void bot.tickTrends().catch(() => log('warn', 'trends_refresh_failed', { reason: 'startup_refresh_failed' }));
  if (config.idleEnabled || config.trendsEnabled) {
    idleTimer = setInterval(() => {
      if (config.idleEnabled) void bot.tickIdle().catch(() => log('error', 'idle_task_failed', { reason: 'internal_error' }));
      if (config.trendsEnabled) void bot.tickTrends().catch(() => log('warn', 'trends_refresh_failed', { reason: 'periodic_refresh_failed' }));
    }, 60000);
    idleTimer.unref();
  }
  if (process.env.FATFISH_LOCAL_SERVICE === '1') {
    controlTimer = setInterval(() => { if (existsSync(path.resolve('data/runtime/stop.request'))) void stop(); }, 1000);
    controlTimer.unref();
  }
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(idleTimer);
  clearInterval(controlTimer);
  gateway?.stop();
  bot.stop();
  const timeout = setTimeout(() => process.exit(1), 150000);
  timeout.unref();
  await new Promise(resolve => server.close(resolve));
  await bot.drain();
  clearTimeout(timeout);
  log('info', 'server_stopped');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
