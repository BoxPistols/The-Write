import { analyzeRequest, setCorsHeaders } from './_shared.js';

const parseBody = (req) => {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw { status: 400, message: 'Invalid JSON body' };
    }
  }
  return req.body;
};

export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = parseBody(req);
    const data = await analyzeRequest(body);
    res.status(200).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message || err);
    const status = err.status || 500;
    const message = status >= 500 ? 'Internal server error' : (typeof err.message === 'string' ? err.message : 'Internal server error');
    res.status(status).json({ error: message });
  }
}
