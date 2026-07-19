const mongoose = require('mongoose');
const { scoped } = require('../utils/logger');

const log = scoped('MongoDB');

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gps_tracking';

  mongoose.connection.on('connected', () => log.info(`Connected: ${uri}`));
  mongoose.connection.on('error', (err) => log.error('Connection error', { error: err.message }));
  mongoose.connection.on('disconnected', () => log.warn('Disconnected'));

  await mongoose.connect(uri, {
    autoIndex: true,
  });

  return mongoose.connection;
}

module.exports = { connectMongo };
