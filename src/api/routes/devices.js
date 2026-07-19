const express = require('express');
const deviceController = require('../controllers/deviceController');

const router = express.Router();

router.get('/', deviceController.listDevices);
router.get('/connected', deviceController.listConnectedDevices);
router.get('/:imei/status', deviceController.getDeviceStatus);

module.exports = router;
