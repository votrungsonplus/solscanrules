const pino = require('pino');
const settings = require('../config/settings');

const logger = pino({
  level: settings.logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  },
});

module.exports = logger;
