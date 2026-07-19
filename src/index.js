require('dotenv').config();
const http = require('http');
const { createApp } = require('./app');
const { initSocketServer } = require('./socketServer');
const { connectMongo } = require('./config/db');
const { startTcpServers } = require('./tcpServer');
const { startOfflineWatcher } = require('./core/offlineWatcher');
const { scoped } = require('./utils/logger');

const log = scoped('Bootstrap');

async function main() {
  await connectMongo();

  const app = createApp();
  const httpServer = http.createServer(app);
  initSocketServer(httpServer);

  const HTTP_PORT = Number(process.env.HTTP_PORT || 4000);
  httpServer.listen(HTTP_PORT, () => {
    log.info(`HTTP + WebSocket server listening`, { port: HTTP_PORT });
  });

  startTcpServers(); // one TCP listener per registered GPS protocol decoder
  startOfflineWatcher(); // periodic sweep for devices that stopped sending data

  process.on('SIGTERM', () => shutdown(httpServer));
  process.on('SIGINT', () => shutdown(httpServer));
}

function shutdown(httpServer) {
  log.info('Shutting down gracefully...');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref(); // force-exit if close hangs
}

main().catch((err) => {
  log.error('Fatal error during bootstrap', { error: err.message, stack: err.stack });
  process.exit(1);
});
