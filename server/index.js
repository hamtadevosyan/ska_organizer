// server/index.js
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
// simple request logger (add near top, after app.use(express.json()))
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// Dashboard route
app.use('/api/dashboard', require('./routes/dashboard'));
// Attendance route
app.use('/api/attendance', require('./routes/attendance'));
// Inventory route
app.use('/api/inventory', require('./routes/inventory'));
// Schedule route
app.use('/api/schedule', require('./routes/schedule'));
// Activity route
app.use('/api/activity', require('./routes/activity'));
// Children route
app.use('/api/children', require('./routes/children'));
// Rooms route
app.use('/api/rooms', require('./routes/rooms'));

// 404 handler (after all routes)
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

///// global error handler (last middleware)
///app.use((err, req, res, next) => {
///  console.error('Unhandled error:', err);
///  res.status(500).json({ error: 'Internal server error' });
///});
// dev-only global error handler (put at end of index.js)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'Internal server error', message: err && err.message });
});

module.exports = app;

if(require.main == module) {
	(async () => {
		try {
			if (process.env.DB_ADAPTER === 'sequelize') {
				// Lazy require so mock default remains unaffected
				const sequelizeAdapter = require('./services/dbAdapter.sequelize');
				const connectionString = process.env.DATABASE_URL || 'sqlite::memory:';
				await sequelizeAdapter.setup(connectionString);
				console.log('Sequelize adapter initialized');
			}

			const PORT = process.env.PORT || 3001;
			app.listen(PORT, () => {
				console.log(`Server running on port ${PORT}`);
			});
		} catch (err) {
			console.error('Failed to bootstrap application:', err);
			process.exit(1);
		}
	})();
}

