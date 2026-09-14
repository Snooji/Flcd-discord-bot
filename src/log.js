const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`${ts} [${level.toUpperCase()}]`, ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};
