const express = require('express');
const cors = require('cors');
const deviceRoutes = require('./api/routes/devices');
const locationRoutes = require('./api/routes/locations');

function createApp() {
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(express.json());

  app.get('/', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use('/api/devices', deviceRoutes);
  app.use('/api/locations', locationRoutes);

  // Centralized error handler - catches anything thrown/rejected in controllers
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    req.app.get('logger')?.error?.('Unhandled API error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
