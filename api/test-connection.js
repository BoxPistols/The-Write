import { testConnection, resolveKey, setCorsHeaders } from './_shared.js';

export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
    res.status(200).json({ ok: true, provider, source });
  } catch (err) {
    const message = typeof err.message === 'string' ? err.message : 'Connection failed';
    res.status(200).json({ ok: false, provider: req.body?.provider, error: message });
  }
}
