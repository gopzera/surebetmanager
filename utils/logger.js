// Minimal JSON logger. Dependency-free, works in Vercel serverless logs
// and local development. Falls back to pretty-print in TTY.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const envLevel = (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')).toLowerCase();
const MIN = LEVELS[envLevel] ?? LEVELS.info;

const isTTY = !!(process.stdout && process.stdout.isTTY) && process.env.NODE_ENV !== 'production';

function write(level, msg, ctx) {
  if (LEVELS[level] < MIN) return;
  const ts = new Date().toISOString();
  if (isTTY) {
    const color = { debug: 90, info: 36, warn: 33, error: 31 }[level] || 0;
    const prefix = `\x1b[${color}m[${level.toUpperCase()}]\x1b[0m`;
    const ctxStr = ctx && Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
    process.stdout.write(`${prefix} ${ts} ${msg}${ctxStr}\n`);
    return;
  }
  const line = JSON.stringify({ ts, level, msg, ...(ctx || {}) });
  process.stdout.write(line + '\n');
}

function child(bindings) {
  return {
    debug: (msg, ctx) => write('debug', msg, { ...bindings, ...(ctx || {}) }),
    info:  (msg, ctx) => write('info',  msg, { ...bindings, ...(ctx || {}) }),
    warn:  (msg, ctx) => write('warn',  msg, { ...bindings, ...(ctx || {}) }),
    error: (msg, ctx) => write('error', msg, { ...bindings, ...(ctx || {}) }),
    child: (more) => child({ ...bindings, ...more }),
  };
}

const logger = child({});
module.exports = logger;
module.exports.default = logger;
