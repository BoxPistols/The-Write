import crypto from 'crypto';
import { setCorsHeaders } from './_shared.js';

export default function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.BASIC_AUTH_PASSWORD;
  if (!expected) return res.status(200).json({ ok: true });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { password } = body;

  if (password !== expected) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = crypto.createHash('sha256').update(expected).digest('hex');
  const isSecure = req.headers['x-forwarded-proto'] === 'https';
  const cookie = `auth-token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${isSecure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
  res.status(200).json({ ok: true });
}
