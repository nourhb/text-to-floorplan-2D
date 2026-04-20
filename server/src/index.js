import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import aiRoutes from './routes/ai.routes.js';
import { errorHandler } from './middleware/error.middleware.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.use('/ai', aiRoutes);

app.use(errorHandler);

const port = Number(process.env.PORT) || 5009;
app.listen(port, () => {
  console.log(`text-to-floor-plan-ai server running on http://localhost:${port}`);
});

