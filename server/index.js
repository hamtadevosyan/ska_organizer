// server/index.js
require('./config/environment');
const express = require('express');
const cors = require('cors');

const app = express();

app.disable('x-powered-by');
const authConfig = require('./auth/config');
const { originGuard, requireSession, requireOperationalAccess, clearCookie } = require('./auth/middleware');
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', originGuard);
app.use(cors({ origin: (origin, done) => done(null, !!origin && authConfig.origins.has(origin)), credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-CSRF-Token'] }));
app.use(express.json({ limit: '100kb' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', require('./auth/routes').router);
app.use('/api/admin', require('./auth/routes').admin);
app.use('/api', requireSession, requireOperationalAccess);

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

// Never serialize request bodies, cookies, database errors or credentials.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status === 401 && err.code !== 'INVALID_CREDENTIALS') clearCookie(res);
  if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { message: 'Invalid JSON request.' } });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: { message: err.message, fields: err.fields, code: err.code } });
  console.error('Request failed (internal server error).');
  res.status(500).json({ error: { message: 'Internal server error.' } });
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
