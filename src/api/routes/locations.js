const express = require('express');
const locationController = require('../controllers/locationController');

const router = express.Router();

router.get('/live', locationController.getLiveLocations);
router.get('/:imei/latest', locationController.getLatestLocation);
router.get('/:imei/history', locationController.getLocationHistory);

module.exports = router;
