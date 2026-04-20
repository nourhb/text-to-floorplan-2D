import fs from 'fs';

export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const asyncHandler =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export const errorHandler = (err, req, res, next) => {
  const statusCode = Number(err?.statusCode) || 500;
  const message = String(err?.message || 'Internal server error');

  if (String(process.env.NODE_ENV || '').toLowerCase() === 'development') {
    console.error('Error:', err);
    try {
      const timestamp = new Date().toISOString();
      const logMsg = `[${timestamp}] ${req.method} ${req.url} - ${err?.stack || message}\n`;
      fs.appendFileSync('server_errors.log', logMsg);
    } catch {
      // ignore logging failures
    }
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(String(process.env.NODE_ENV || '').toLowerCase() === 'development' && { stack: err?.stack }),
  });
};

