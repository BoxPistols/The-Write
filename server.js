import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { analyzeRequest, getAvailableProviders } from './api/_shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files in production
app.use(express.static(join(__dirname, 'dist')));

// Available API keys endpoint
app.get('/api/providers', (req, res) => {
  res.json(getAvailableProviders());
});

// ─── Unified Analyze Endpoint ──────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const data = await analyzeRequest(req.body);
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message || err);
    const status = err.status || 500;
    const message = typeof err.message === 'string' ? err.message : 'Internal server error';
    res.status(status).json({ error: message });
  }
});

// SPA fallback for production
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`API proxy running on http://localhost:${PORT}`);
});
