import { systemOne, systemOneBatch } from './_jev.js';
import { setCorsHeaders } from './_shared.js';

const parseBody = (req) => {
  if (req.body == null) throw { status: 400, message: 'Missing JSON body' };
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString('utf8')); } catch { throw { status: 400, message: 'Invalid JSON body' }; }
  }
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw { status: 400, message: 'Invalid JSON body' }; }
  }
  return req.body;
};

// 1リクエストで受け付ける判定の数。入力中の本文はいくらでも長くなるので、
// 上限が無いと1打鍵で数百件をJevに投げることになる。溢れた文は次の打鍵で拾う。
const MAX_ITEMS = 64;

/**
 * Jevへの判定を代理する。
 * 単発は {state, questions}、まとめては {items:[{id,state,questions}]} で受ける。
 * どちらもanswersをそのまま返し、閾値の適用はしない。どこから指摘とみなすかは
 * src/config/jevQuestions.jsに置いてあり、サーバーとクライアントで二重に持たない。
 */
export async function handleJev(body, res) {
  const clientKey = body?.clientKeys?.jev;
  const common = { apiKey: clientKey, timeoutMs: body?.timeoutMs };

  if (Array.isArray(body?.items)) {
    if (body.items.length > MAX_ITEMS) {
      throw { status: 400, message: `items must be ${MAX_ITEMS} or fewer (got ${body.items.length})` };
    }
    const startedAt = Date.now();
    const results = await systemOneBatch(body.items, { ...common, concurrency: body.concurrency });
    // 何件成功したかは呼び出し側で数えられるが、まとめたときの実時間は
    // ここでしか測れない。ベンチと画面のどちらもこの値を使う。
    return res.status(200).json({ results, wallMs: Date.now() - startedAt });
  }

  const result = await systemOne({ state: body?.state, questions: body?.questions, model: body?.model }, common);
  return res.status(200).json(result);
}

export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    return await handleJev(parseBody(req), res);
  } catch (err) {
    console.error('Jev proxy error:', err.message || err);
    const status = err.status || 500;
    const message = status >= 500 ? 'Internal server error' : (typeof err.message === 'string' ? err.message : 'Internal server error');
    res.status(status).json({ error: message });
  }
}
