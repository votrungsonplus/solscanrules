const orchestrator = require('./core/orchestrator');
const server = require('./web/server');
const monitor = require('./services/monitor-service');
const logger = require('./utils/logger');

async function main() {
  try {
    // 1. Start core orchestrator first (Initializes DB & loads settings)
    await orchestrator.start();
    
    // 2. Start secondary services once DB is ready
    monitor.start();
    server.start();

    logger.info('Bot startup complete (Full Persistence Active)');
  } catch (err) {
    logger.fatal(`Failed to start bot: ${err.message}`);
    logger.fatal(err.stack);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT');
  await orchestrator.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM');
  await orchestrator.stop();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.fatal(`Uncaught exception: ${err.message}`);
  logger.fatal(err.stack);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

main();
