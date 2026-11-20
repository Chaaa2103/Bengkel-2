'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { wrap } = require('../util');

const router = express.Router();
router.get('/', requireAuth, wrap(async (req, res) => res.json(await db.q(
  'SELECT notification_id, booking_id, type, message, status, sent_at FROM notifications WHERE user_id = ? ORDER BY notification_id DESC LIMIT 50', [req.user.user_id]))));
module.exports = router;
