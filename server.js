import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import productsRouter from './routes/products.js';
import ordersRouter from './routes/orders.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = [
  process.env.STORE_FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174',
].filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

app.use(
  rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'watch-store-api', time: new Date().toISOString() });
});

app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Watch Store API running on http://localhost:${PORT}`);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('WARNING: Supabase credentials not set. API will fail until .env is configured.');
  }
});
