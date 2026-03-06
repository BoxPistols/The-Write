import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { analyzeRequest, getAvailableProviders, testConnection, resolveKey } from './api/_shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());

// パスワード認証（Cookie方式、BASIC_AUTH_PASSWORD 設定時のみ有効）
if (process.env.BASIC_AUTH_PASSWORD) {
  const expectedToken = crypto.createHash('sha256').update(process.env.BASIC_AUTH_PASSWORD).digest('hex');

  function getCookie(header, name) {
    if (!header) return null;
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  // ログインエンドポイント（認証不要）
  app.post('/api/login', express.json(), (req, res) => {
    const { password } = req.body || {};
    if (password !== process.env.BASIC_AUTH_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    res.setHeader('Set-Cookie', `auth-token=${expectedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`);
    res.json({ ok: true });
  });

  // 認証チェックミドルウェア
  const LOGIN_HTML = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Write</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh}.c{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;width:100%;max-width:360px}h1{font-size:1.25rem;margin-bottom:.5rem}p{font-size:.875rem;color:#888;margin-bottom:1.5rem}input{width:100%;padding:.625rem .75rem;background:#0a0a0a;border:1px solid #444;border-radius:8px;color:#e5e5e5;font-size:.9375rem;outline:none}input:focus{border-color:#6366f1}button{width:100%;margin-top:1rem;padding:.625rem;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:.9375rem;cursor:pointer}button:hover{background:#5558e6}button:disabled{opacity:.6;cursor:default}.e{color:#ef4444;font-size:.8125rem;margin-top:.5rem;display:none}</style></head><body><div class="c"><h1>The Write</h1><p>パスワードを入力してください</p><form id="f"><input type="password" id="pw" placeholder="パスワード" autofocus required><div class="e" id="e">パスワードが正しくありません</div><button type="submit" id="b">ログイン</button></form></div><script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const pw=document.getElementById('pw'),err=document.getElementById('e'),btn=document.getElementById('b');err.style.display='none';btn.disabled=true;btn.textContent='...';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});if(r.ok){location.reload()}else{err.style.display='block';btn.disabled=false;btn.textContent='ログイン'}}catch(x){err.textContent='接続エラー';err.style.display='block';btn.disabled=false;btn.textContent='ログイン'}});</script></body></html>`;

  app.use((req, res, next) => {
    if (req.path === '/api/login') return next();
    const token = getCookie(req.headers.cookie, 'auth-token');
    if (token === expectedToken) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.send(LOGIN_HTML);
  });
}

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
    const message = status >= 500
      ? 'Internal server error'
      : (typeof err.message === 'string' ? err.message : 'Internal server error');
    res.status(status).json({ error: message });
  }
});

// ─── Connection Test Endpoint ──────────────────────
app.post('/api/test-connection', async (req, res) => {
  try {
    const { provider, clientKeys } = req.body || {};
    if (!provider) {
      return res.status(400).json({ ok: false, error: 'provider is required' });
    }
    const apiKey = resolveKey(provider, clientKeys);
    if (!apiKey) {
      return res.status(200).json({ ok: false, provider, error: 'API key not provided' });
    }
    const source = clientKeys?.[provider] ? 'client' : 'server';
    await testConnection(provider, apiKey);
    res.json({ ok: true, provider, source });
  } catch (err) {
    const message = typeof err.message === 'string' ? err.message : 'Connection failed';
    res.status(200).json({ ok: false, provider: req.body?.provider, error: message });
  }
});

// SPA fallback for production
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`API proxy running on http://localhost:${PORT}`);
});
