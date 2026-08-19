/**
 * src/utils/logger.js
 * ---------------------------------------------------------------------------
 * Makes `pm2 logs` readable. Requiring this file ONCE (first line of app.js)
 * wraps console.* so EVERY log line — including the 200+ existing console.log
 * calls across the codebase — is prefixed with an IST timestamp and a level:
 *
 *   2026-08-19 20:00:12  INFO   [scheduler] quiz_trigger @20:00: 42 to send
 *   2026-08-19 20:00:13  ERROR  [scheduler] quiz_trigger failed for 9198...: ...
 *
 * No call sites change; the existing [tag] messages just gain a when + a level.
 * Colours are emitted only on a TTY, so pm2's log files stay clean plain text.
 *
 * It also exposes a small logger API — logger.info/warn/error/debug(...) —
 * for new code that wants to log directly. debug() is silent unless LOG_DEBUG=1.
 */
const TZ = process.env.TZ_NAME || "Asia/Kolkata";

const DATE = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const TIME = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const stamp = () => { const d = new Date(); return `${DATE.format(d)} ${TIME.format(d)}`; };

const C = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", green: "\x1b[32m" };
const useColor = !!process.stdout.isTTY && process.env.NO_COLOR !== "1";
const paint = (c, s) => (useColor ? c + s + C.reset : s);
const LEVEL_COLOR = { INFO: C.cyan, WARN: C.yellow, ERROR: C.red, DEBUG: C.dim, LOG: C.dim };

// Keep the real methods so we never recurse through the wrapper.
const raw = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const prefix = (level) => [paint(C.dim, stamp()), " ", paint(LEVEL_COLOR[level] || C.dim, level.padEnd(5)), " "];
const wrap = (level, sink) => (...args) => sink(prefix(level).join("") , ...args);

// Only install once, even if this module is required from several places.
if (!console.__qpWrapped) {
  console.log = wrap("LOG", raw.log);
  console.info = wrap("INFO", raw.info);
  console.warn = wrap("WARN", raw.warn);
  console.error = wrap("ERROR", raw.error);
  console.__qpWrapped = true;
}

const logger = {
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: (...a) => { if (process.env.LOG_DEBUG === "1") raw.log(prefix("DEBUG").join(""), ...a); },
  /** logger.tag('wa') → a logger whose lines start with [wa]. */
  tag: (t) => ({
    info: (...a) => console.info(`[${t}]`, ...a),
    warn: (...a) => console.warn(`[${t}]`, ...a),
    error: (...a) => console.error(`[${t}]`, ...a),
    debug: (...a) => { if (process.env.LOG_DEBUG === "1") raw.log(prefix("DEBUG").join(""), `[${t}]`, ...a); },
  }),
};

module.exports = logger;
