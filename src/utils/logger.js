const winston = require('winston');

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}] ${stack || message}${metaStr}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Convenience namespaced loggers so log lines are traceable to the requirement
// they satisfy (Section 8: Logging - device connect/disconnect, packet errors, etc.)
function scoped(namespace) {
  return {
    info: (msg, meta) => logger.info(`[${namespace}] ${msg}`, meta),
    warn: (msg, meta) => logger.warn(`[${namespace}] ${msg}`, meta),
    error: (msg, meta) => logger.error(`[${namespace}] ${msg}`, meta),
    debug: (msg, meta) => logger.debug(`[${namespace}] ${msg}`, meta),
  };
}

module.exports = { logger, scoped };
