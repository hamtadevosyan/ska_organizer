// server/index.js
const express = require('express');
const cors = require('cors');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
app.use(cors());
app.use('/api/dashboard', dashboardRoutes);

const PORT = 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

