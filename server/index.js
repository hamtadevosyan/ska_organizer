// server/index.js
require('./config/environment');
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
// Menu route
app.use("/api/menu", require("./routes/menu"));
// Shopping route
app.use("/api/shopping", require("./routes/shopping"));
// Shelf route
app.use("/api/shelf", require("./routes/shelf"));
// Meals route
app.use("/api/meals", require("./routes/meals"));
app.use("/api/ingredients", require("./routes/ingredients"));
app.use("/api/meals", require("./routes/mealIngredients"));


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

if (require.main === module) {
  const db = require('./services/dbAdapter');
  (async () => {
    try {
      if (db.setup) {
        await db.setup(process.env.DATABASE_URL, { schema: process.env.DB_SCHEMA || 'public' });
        console.log('PostgreSQL storage initialized');
      } else {
        console.log('Mock storage enabled: data is lost when the server stops.');
      }
      const port = process.env.PORT || 3001;
      const server = app.listen(port, () => console.log(`Server running on port ${port}`));
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        const deadline = setTimeout(() => process.exit(1), 10000);
        deadline.unref();
        server.close(async () => {
          await db.close?.();
          clearTimeout(deadline);
        });
      };
      server.on('error', async (error) => {
        console.error(`Could not listen on port ${port} (${error.code}).`);
        await db.close?.();
        process.exitCode = 1;
      });
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    } catch (error) {
      // Do not print connection URLs, passwords or Sequelize connection objects.
      const message = /^(DATABASE_URL|Database migrations|Invalid database schema)/.test(error.message)
        ? error.message : 'Could not initialize PostgreSQL. Check DATABASE_URL and database availability.';
      console.error(`Server startup failed: ${message}`);
      await db.close?.();
      process.exitCode = 1;
    }
  })();
}
