// QQ官方WSS。凭证只存在连接闭包中；不输出帧、会话ID或鉴权内容。
export function createGateway(config, { bot, access, createSocket = url => new WebSocket(url), log = () => {}, onReady = () => {},
  later = setTimeout, cancel = clearTimeout, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let socket, heartbeat, deadline, retry;
  let state = 'stopped', stopped = true, generation = 0, failures = 0;
  let session, sequence = null, waitingAck = false, queue = Promise.resolve(), queued = 0;
  const fatalCodes = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);
  function timer(fn, ms) { const handle = later(fn, ms); handle?.unref?.(); return handle; }
  function clearConnection() {
    cancel(heartbeat); cancel(deadline); heartbeat = deadline = undefined;
    waitingAck = false;
    const previous = socket; socket = undefined;
    try { previous?.close(1000); } catch {}
    bot.pauseIdleFeed?.();
  }
  function reconnect(reason, { reset = false, fatal = false, code } = {}) {
    if (stopped || state === 'backoff' || state === 'blocked') return;
    generation++;
    state = fatal ? 'blocked' : 'backoff';
    clearConnection();
    if (reset) { session = undefined; sequence = null; }
    log(fatal ? 'error' : 'warn', fatal ? 'gateway_blocked' : 'gateway_reconnecting', { reason, api_code: code });
    if (fatal) return;
    const wait = Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
    retry = timer(() => { if (!stopped) void connect(); }, wait);
  }
  function send(payload) {
    if (!socket || socket.readyState !== 1) throw new Error('socket_not_open');
    socket.send(JSON.stringify(payload));
  }
  function beat(interval, epoch) {
    if (stopped || epoch !== generation) return;
    if (waitingAck) { reconnect('heartbeat_timeout'); return; }
    try { waitingAck = true; send({ op: 1, d: sequence }); }
    catch { reconnect('heartbeat_send_failed'); return; }
    heartbeat = timer(() => beat(interval, epoch), interval);
  }
  function dispatch(payload, epoch) {
    if (++queued > 100) { queued--; reconnect('event_queue_full'); return; }
    queue = queue.then(async () => {
      try {
        if (stopped || epoch !== generation) return;
        if (payload.t === 'READY' || payload.t === 'RESUMED') {
          if (payload.t === 'READY') {
            if (typeof payload.d?.session_id !== 'string' || payload.d.session_id.length > 1024) { reconnect('invalid_ready', { reset: true }); return; }
            session = payload.d.session_id;
            bot.setSelfUser?.(payload.d.user);
          }
          state = 'ready'; failures = 0; cancel(deadline);
          log('info', payload.t === 'READY' ? 'gateway_ready' : 'gateway_resumed');
          Promise.resolve().then(onReady).catch(() => log('warn', 'startup_greeting_failed', { reason: 'ready_callback_failed' }));
        } else {
          const started = now();
          let result = bot.submit(payload);
          while (result.kind === 'busy' && !stopped && epoch === generation && now() - started < 240000) {
            await delay(250);
            if (stopped || epoch !== generation) return;
            result = bot.submit(payload);
          }
          if (result.kind === 'busy') { reconnect('event_busy_resume'); return; }
          if (result.kind === 'ignored') log('info', 'event_ignored', { reason: result.reason });
        }
        if (epoch === generation && Number.isSafeInteger(payload.s) && payload.s >= 0) sequence = payload.s;
      } catch { reconnect('dispatch_failed'); }
      finally { queued--; }
    });
  }
  async function connect() {
    if (stopped) return;
    const epoch = ++generation;
    state = 'connecting'; queue = Promise.resolve();
    try {
      const info = await access();
      if (stopped || epoch !== generation) return;
      socket = createSocket(info.url);
      deadline = timer(() => reconnect('handshake_timeout'), 25000);
      socket.addEventListener('message', event => {
        if (stopped || epoch !== generation) return;
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > config.maxBodyBytes) { reconnect('invalid_gateway_frame', { reset: true }); return; }
        let payload;
        try { payload = JSON.parse(event.data); } catch { reconnect('invalid_gateway_json', { reset: true }); return; }
        if (payload.op === 10) {
          const interval = payload.d?.heartbeat_interval;
          if (!Number.isInteger(interval) || interval < 1000 || interval > 120000 || heartbeat) { reconnect('invalid_hello', { reset: true }); return; }
          try {
            if (session && sequence !== null) send({ op: 6, d: { token: info.token, session_id: session, seq: sequence } });
            else send({ op: 2, d: { token: info.token, intents: 1 << 25, shard: [0, 1], properties: { $os: process.platform, $browser: 'fatfish', $device: 'fatfish' } } });
            heartbeat = timer(() => beat(interval, epoch), interval);
          } catch { reconnect('identify_failed'); }
        } else if (payload.op === 11) waitingAck = false;
        else if (payload.op === 1) {
          try { waitingAck = true; send({ op: 1, d: sequence }); } catch { reconnect('heartbeat_send_failed'); }
        } else if (payload.op === 7) reconnect('server_requested');
        else if (payload.op === 9) reconnect('invalid_session', { reset: true });
        else if (payload.op === 0) {
          if (payload.t === 'READY' || payload.t === 'RESUMED') cancel(deadline);
          dispatch(payload, epoch);
        }
      });
      socket.addEventListener('close', event => {
        if (stopped || epoch !== generation) return;
        reconnect('socket_closed', { code: event.code, reset: [4006, 4007].includes(event.code) || event.code >= 4900, fatal: fatalCodes.has(event.code) });
      });
      socket.addEventListener('error', () => { if (!stopped && epoch === generation) reconnect('socket_error'); });
    } catch { if (!stopped && epoch === generation) reconnect('gateway_access_failed'); }
  }
  return {
    start() { if (!stopped) return; stopped = false; void connect(); },
    stop() { stopped = true; state = 'stopped'; generation++; cancel(retry); clearConnection(); },
    get status() { return { state, reconnects: failures, queued: Math.max(0, queued) }; }
  };
}
