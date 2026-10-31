const fields = new Set(['group_openid', 'reason', 'status', 'api_code', 'trace_id', 'elapsed_ms', 'inflight', 'port', 'host', 'mode', 'tokens', 'summary_chars', 'turns', 'finish_reason', 'terms']);

// 仅允许固定诊断字段；不记录请求头、密钥、用户 OpenID、消息正文或完整异常。
export function createLogger(write = line => process.stdout.write(line + '\n')) {
  return (level, event, details = {}) => {
    const entry = { time: new Date().toISOString(), level, event };
    for (const [key, value] of Object.entries(details)) {
      if (fields.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
        entry[key] = typeof value === 'string' ? value.slice(0, 256) : value;
      }
    }
    write(JSON.stringify(entry));
  };
}
