import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class MemoryStorageError extends Error {
  constructor(reason) { super(`memory: ${reason}`); this.reason = reason; }
}

const digest = value => createHash('sha256').update(value).digest('hex');

export function createFilePersistence(config, io = fs) {
  const namespace = digest(`${config.appId}\0${config.contextScope}`).slice(0, 24);
  const root = path.resolve(config.contextDataDir, namespace);
  try { io.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  catch { throw new MemoryStorageError('directory_unavailable'); }

  function encode(data) {
    return JSON.stringify({ data, checksum: digest(JSON.stringify(data)) });
  }
  function decode(text) {
    const envelope = JSON.parse(text);
    if (!envelope?.data || envelope.checksum !== digest(JSON.stringify(envelope.data))) throw new Error('checksum');
    return envelope.data;
  }
  function writeFile(file, text, exclusive = false) {
    const temporary = exclusive ? file : `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = io.openSync(temporary, 'wx', 0o600);
      io.writeFileSync(fd, text, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      if (!exclusive) io.renameSync(temporary, file);
      if (process.platform !== 'win32') {
        const directoryFd = io.openSync(root, 'r');
        try { io.fsyncSync(directoryFd); } finally { io.closeSync(directoryFd); }
      }
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (!exclusive) { try { io.unlinkSync(temporary); } catch {} }
      if (exclusive && error.code === 'EEXIST') return false;
      throw new MemoryStorageError('write_failed');
    }
    return true;
  }

  const identityFile = path.join(root, 'identity.json');
  if (!io.existsSync(identityFile)) writeFile(identityFile, encode({ version: 1, aliasKey: randomBytes(32).toString('base64') }), true);
  let aliasKey;
  try {
    if (io.statSync(identityFile).size > 4096) throw new Error('size');
    const identity = decode(io.readFileSync(identityFile, 'utf8'));
    aliasKey = Buffer.from(identity.aliasKey, 'base64');
    if (identity.version !== 1 || aliasKey.length !== 32) throw new Error('identity');
  } catch { throw new MemoryStorageError('identity_corrupt'); }

  function valid(state, id) {
    if (state.version !== 1 || state.id !== id || typeof state.epoch !== 'string' ||
        !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        !Number.isSafeInteger(state.compactions) || state.compactions < 0 ||
        !Number.isFinite(state.updatedAt) || typeof state.summary !== 'string' ||
        Array.from(state.summary).length > config.contextSummaryMaxChars || !Array.isArray(state.messages) ||
        state.messages.length % 2 || state.messages.length > (config.contextPendingMaxTurns + 1) * 2) return false;
    return state.messages.every((message, i) => message?.role === (i % 2 ? 'assistant' : 'user') &&
      typeof message.content === 'string' && Array.from(message.content).length <= (i % 2 ? config.maxReply : config.maxInput) &&
      (message.name === undefined || (typeof message.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(message.name))));
  }
  return {
    getAliasKey: () => Buffer.from(aliasKey),
    read(key) {
      const id = digest(key);
      const file = path.join(root, `${id}.json`);
      try {
        const maximumBytes = (config.contextPendingMaxChars + config.contextSummaryMaxChars + config.maxInput + config.maxReply) * 8 + 131072;
        if (io.statSync(file).size > maximumBytes) throw new Error('size');
        const state = decode(io.readFileSync(file, 'utf8'));
        if (!valid(state, id)) throw new Error('schema');
        return state;
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw new MemoryStorageError('snapshot_corrupt');
      }
    },
    write(key, state) {
      const id = digest(key);
      const data = { version: 1, id, epoch: state.epoch, revision: state.revision,
        summary: state.summary, messages: state.messages, updatedAt: state.updatedAt, compactions: state.compactions };
      if (!valid(data, id)) throw new MemoryStorageError('invalid_snapshot');
      writeFile(path.join(root, `${id}.json`), encode(data));
    }
  };
}
