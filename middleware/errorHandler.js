export function errorHandler(err, req, res, next) {
  console.error('[API Error]', err.message);

  // Don't leak internal details
  if (err.message && err.message.includes('Insufficient stock')) {
    return res.status(409).json({ error: err.message });
  }
  if (err.message && err.message.includes('Product not found')) {
    return res.status(404).json({ error: err.message });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message || 'Request failed',
  });
}

export function notFound(req, res) {
  res.status(404).json({ error: 'Endpoint not found' });
}
