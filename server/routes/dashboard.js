const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    totalStudents: 42,
    totalStaff: 6,
    inventoryCount: 140,
    recentActivities: [
      'Outdoor playtime completed',
      'New books added to library',
      'Weekly staff meeting held'
    ]
  });
});

module.exports = router;

