// server/index.js
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Attendance route
app.use('/api/attendance', require('./routes/attendance'));
// Inventory route
app.use('/api/inventory', require('./routes/inventory'));
// Schedule route
app.use('/api/schedule', require('./routes/schedule'));
// Activity route
app.use('/api/activity', require('./routes/activity'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

