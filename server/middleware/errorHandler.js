// server/middleware/errorHandler.js
module.exports = (err, req, res, next) => {
  // Normalize known error shapes
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Optional: include details for validation errors
  const details = err.details || null;

  // Log server errors (only stack for 5xx)
  if (status >= 500) {
    console.error(err.stack || err);
  } else {
    console.warn(err.message || err);
  }

  res.status(status).json({
    error: {
      message,
      ...(details ? { details } : {})
    }
  });
};

