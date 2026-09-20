import { systemOne, systemOneBatch } from './_jev.js';
import { setCorsHeaders } from './_shared.js';
import { MAX_ITEMS_PER_REQUEST } from '../src/config/jevQuestions.js';

/**
 * 本文をJSONとして読む。実行環境によってBufferでも文字列でも来る。
 * @param {import('http').IncomingMessage & {body?: unknown}} req
 * @returns {object}
 */
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
// 上限が無いと1打鍵で数百件をJevに投げることになる。
// クライアント側(src/utils/jevClient.js)がこの数で分割して投げてくる。
const MAX_ITEMS = MAX_ITEMS_PER_REQUEST;

/**
 * Jevへの判定を代理する。
 * 単発は {state, questions}、まとめては {items:[{id,state,questions}]} で受ける。
 * どちらもanswersをそのまま返し、閾値の適用はしない。どこから指摘とみなすかは
 * src/config/jevQuestions.jsに置いてあり、サーバーとクライアントで二重に持たない。
 *
 * @param {object} body リクエスト本文
 * @param {object} res レスポンス
 * @param {AbortSignal} [signal] 呼び出し元が切れたことを下流へ伝える
 */
export async function handleJev(body, res, signal) {
  const clientKey = body?.clientKeys?.jev;
  const common = { apiKey: clientKey, timeoutMs: body?.timeoutMs, signal };

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

/**
 * 呼び出し元が切れたら、下流のJevへの往復も止める。
 * 止めないと、誰も受け取らない応答のために外部APIを叩き続けることになる。
 * まとめ投げでは残りの文まで投げに行く。
 *
 * @param {import('http').IncomingMessage} req
 * @param {object} res
 * @param {(signal: AbortSignal) => Promise<unknown>} run
 */
export async function withClientAbort(req, res, run) {
  const controller = new AbortController();
  let settled = false;
  // 応答を返し切ったあとにも'close'は来る。そこで倒しても害は無いが、
  // 中断として記録されるので、終わったかどうかを見てから倒す。
  const onClose = () => { if (!settled) controller.abort(); };
  req.on?.('close', onClose);

  try {
    return await run(controller.signal);
  } finally {
    settled = true;
    req.off?.('close', onClose);
  }
}

/** @param {import('http').IncomingMessage} req @param {object} res */
export async function respondToJev(req, res) {
  try {
    return await withClientAbort(req, res, (signal) => handleJev(parseBody(req), res, signal));
  } catch (err) {
    // 呼び出し元が切れているので、書き込む先はもう無い。
    if (err?.status === 499) return undefined;
    console.error('Jev proxy error:', err.message || err);
    const status = err.status || 500;
    const message = status >= 500 ? 'Internal server error' : (typeof err.message === 'string' ? err.message : 'Internal server error');
    return res.status(status).json({ error: message });
  }
}

/** @param {import('http').IncomingMessage} req @param {object} res */
export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  return respondToJev(req, res);
}
