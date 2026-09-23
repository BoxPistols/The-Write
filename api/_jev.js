// Jev(TypeSafe AI)への問い合わせ。
//
// 公式SDK(@typesafe-ai/sdk)は入れず、素のfetchで叩く。このAPIはPOST /v1/systemoneの
// 1本しかなく、_shared.jsが他のプロバイダーを同じ形で扱っている。ここだけSDKに寄せると
// 読み口が割れるわりに、省けるのはリトライとタイムアウトの数十行だけになる。
// 契約はSDKの型定義に合わせてあり、質問の形はsrc/config/jevQuestions.jsと対で追える。

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';

// Jevは文章を書かないぶん速い。遅れた判定は打鍵で上書きされて捨てられるので、
// 待ち続けるより落として次の入力でやり直すほうが画面の更新は速く見える。
// SDKの既定(10s)より短く取っているのはそのため。
const DEFAULT_TIMEOUT_MS = 6000;

// 1リクエストにまとめる並列数。文ごとに1リクエスト投げるので、
// ブラウザの6本制限ではなくサーバー側で束ねる。
// 同時に走らせるのは5件程度までにする（上流の目安）。
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 12;

// 投げ直すのは混んでいるときだけ。500や422を投げ直しても同じ答えが返るうえ、
// 1文につき1回呼ぶので、無駄な往復がそのまま回数の上限を削る。
const RETRY_STATUSES = new Set([429, 529]);
const MAX_RETRIES = 2;

// 記録した応答で回すときだけ、手元のhttpを許す。
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const DEFAULT_HOST = 'api.typesafe.ai';

/**
 * APIキーを送ってよい宛先。
 * httpsは経路を守るが、相手が誰かは保証しない。環境変数を書ける人が
 * 手元のホストへ鍵を転送できてしまうので、宛先そのものを絞る。
 *
 * ゲートウェイ経由で使う構成は実在するため、TYPESAFE_ALLOWED_HOSTSで
 * 明示的に足せるようにする。既定に入れないのは、鍵の転送先を増やすのは
 * 意図して行うべき設定だから。
 * @returns {Set<string>}
 */
function allowedHosts() {
  const extra = (process.env.TYPESAFE_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([DEFAULT_HOST, ...extra]);
}

/**
 * 宛先を決める。
 * ここにはBearerのAPIキーを載せて投げるので、平文になる設定も、
 * 許可していないホストも通さない。手元のループバックだけは例外にする。
 * 手元に立てたスタブサーバーがそこに入る。
 * @returns {string} 末尾のスラッシュを落としたURL
 */
function resolveBaseURL() {
  const raw = process.env.TYPESAFE_BASE_URL;
  if (!raw) return DEFAULT_BASE_URL;

  let url;
  try { url = new URL(raw); } catch {
    throw { status: 500, message: `TYPESAFE_BASE_URL is not a valid URL: ${raw}` };
  }

  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK.has(host);

  if (url.protocol === 'http:') {
    if (!loopback) {
      throw { status: 500, message: 'TYPESAFE_BASE_URL must use https (http is allowed only for localhost)' };
    }
    return raw.replace(/\/+$/, '');
  }
  if (url.protocol !== 'https:') {
    throw { status: 500, message: `TYPESAFE_BASE_URL must use https, got ${url.protocol}` };
  }
  if (!loopback && !allowedHosts().has(host)) {
    throw {
      status: 500,
      message: `TYPESAFE_BASE_URL host is not allowed: ${host} (add it to TYPESAFE_ALLOWED_HOSTS to permit a gateway)`,
    };
  }
  return raw.replace(/\/+$/, '');
}

/**
 * 鍵・宛先・既定モデルをまとめて返す。
 * @returns {{apiKey: string|null, baseURL: string, model: string}}
 */
export function jevConfig() {
  return {
    apiKey: process.env.TYPESAFE_API_KEY || null,
    baseURL: resolveBaseURL(),
    model: process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL,
  };
}

/**
 * サーバーにJevの鍵が入っているか。画面の出し分けに使う。
 * @returns {boolean}
 */
export function hasJevKey() {
  return !!process.env.TYPESAFE_API_KEY;
}

/**
 * 質問の形を投げる前に確かめる。
 * サーバーは400で弾いてくれるが、文の数だけ往復してから気づくと遅いうえに、
 * どの文で壊れたのかが分からなくなる。
 * @param {object} questions 名前をキーにした質問の集まり
 * @throws {{status: 400, message: string}} 形が契約に合わないとき
 */
export function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw { status: 400, message: 'questions must be an object' };
  }
  const names = Object.keys(questions);
  if (names.length === 0) throw { status: 400, message: 'questions must not be empty' };

  for (const name of names) {
    const q = questions[name];
    if (!q || typeof q !== 'object') throw { status: 400, message: `question "${name}" must be an object` };
    if (q.type === 'noul') continue;
    if (q.type === 'choice') {
      const labels = Object.keys(q.criteria || {});
      if (labels.length < 2) throw { status: 400, message: `choice "${name}" needs at least 2 labels` };
      continue;
    }
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw { status: 400, message: `score "${name}" needs a rubric of at least 2 entries` };
      }
      continue;
    }
    throw { status: 400, message: `question "${name}" has unknown type: ${q.type}` };
  }
}

/**
 * 呼び出し側の中断を表すエラー。タイムアウト(504)と分けておかないと、
 * 打鍵由来のキャンセルがベンチの遅延分布に混ざる。
 * @returns {{status: 499, message: string}}
 */
const aborted = () => ({ status: 499, message: 'Jev request aborted by caller' });

/**
 * 中断できる待ち。
 * 素のsetTimeoutだと、待っているあいだに中断されても待ち切ってから
 * 次のfetchを始めてしまう。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(aborted());
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); reject(aborted()); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Retry-Afterは秒とミリ秒の両方が返りうる。読めない値と無い値はnullを返し、
 * 呼び出し側の指数バックオフに任せる。
 *
 * headers.get()はヘッダが無いとnullを返し、Number(null)は0になる。
 * そのまま通すと「0ミリ秒待て」と読んでしまい、429や5xxに間を置かず
 * 投げ直すことになる。無い値は数として扱わない。
 * @param {Headers} headers
 * @returns {number|null}
 */
export function retryAfterMs(headers) {
  const read = (name) => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const ms = read('retry-after-ms');
  if (ms !== null) return ms;
  const seconds = read('retry-after');
  return seconds === null ? null : seconds * 1000;
}

/**
 * 1回ぶんのsystemOne。
 * @param {{state: any, questions: object, model?: string}} request
 * @param {{timeoutMs?: number, signal?: AbortSignal, apiKey?: string}} [options]
 * @returns {Promise<{model: string, answers: object, usage: object, latencyMs: number, requestId: string|undefined}>}
 */
export async function systemOne(request, options = {}) {
  const cfg = jevConfig();
  // 利用者が画面から入れた鍵を優先する。他のプロバイダーと同じ扱いに揃える。
  const apiKey = options.apiKey || cfg.apiKey;
  const { baseURL, model } = cfg;
  if (!apiKey) throw { status: 401, message: 'TYPESAFE_API_KEY is not set' };

  validateQuestions(request?.questions);

  const timeoutMs = options.timeoutMs || Number(process.env.TYPESAFE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({
    model: request.model || model,
    state: request.state ?? null,
    questions: request.questions,
  });

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    // addEventListenerは中断済みのsignalに対して発火しない。先に見ておかないと、
    // すでに中断された呼び出しでも1回目のfetchが出てしまう。
    if (options.signal?.aborted) throw aborted();

    // 呼び出し側の中断と自前のタイムアウトで同じcontrollerを倒す。
    // どちらが倒したかは timedOut で見分ける。中断を「タイムアウト」と report すると、
    // ベンチの遅延分布に打鍵由来のキャンセルが混ざる。
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    try {
      const res = await fetch(`${baseURL}/v1/systemone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        const err = { status: res.status, message: `Jev error ${res.status}: ${errBody}` };
        if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
          lastError = err;
          const wait = retryAfterMs(res.headers) ?? 300 * 2 ** attempt;
          await sleep(Math.min(wait, 5000), options.signal);
          continue;
        }
        throw err;
      }

      const data = await res.json();
      return {
        model: data.model,
        answers: data.answers || {},
        usage: data.usage || { input_tokens: 0, output_tokens: 0 },
        latencyMs: Date.now() - startedAt,
        requestId: res.headers.get('x-typesafe-request-id') || undefined,
      };
    } catch (err) {
      if (err?.status) throw err;
      if (options.signal?.aborted) throw aborted();

      // タイムアウトは投げ直さない。timeoutMs は「この時間を過ぎた判定はもう使わない」という
      // 上限であって、1回あたりの上限ではない。ここで再試行すると 6s×3 に待ち時間が乗って
      // 19秒かかり、その間に打鍵が進んで答えのほうが捨てられる。
      // 繋がらなかった側（DNS・接続断）は速く落ちるので、そちらだけ投げ直す。
      if (timedOut) throw { status: 504, message: `Jev request timed out after ${timeoutMs}ms` };

      lastError = { status: 502, message: `Jev connection failed: ${err?.message || err}` };
      if (attempt < MAX_RETRIES) {
        await sleep(300 * 2 ** attempt, options.signal);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError || { status: 500, message: 'Jev request failed' };
}

/**
 * 複数の判定をまとめて出す。
 * 1件の失敗で全部を落とさない。入力中の画面では、9文のうち1文が落ちても
 * 残り8文の下線は出したほうが使える。呼び出し側がidで突き合わせる。
 *
 * @param {Array<{id: string, state: any, questions: object, model?: string}>} items
 * @param {{concurrency?: number, timeoutMs?: number, signal?: AbortSignal, apiKey?: string}} [options]
 * @returns {Promise<Array<{id: string, ok: boolean, answers?: object, usage?: object, latencyMs: number, error?: string}>>}
 */
/**
 * まとめ投げの入力を、workerを立てる前に確かめる。
 * 立ててから気づくと、中身の無い結果や、記録する側の例外になる。
 * @param {Array} items
 * @param {number} [concurrency]
 * @throws {{status: 400, message: string}}
 */
export function validateBatch(items, concurrency) {
  if (!Array.isArray(items) || items.length === 0) {
    throw { status: 400, message: 'items must be a non-empty array' };
  }
  // 文字列を渡されるとlimitがNaNになり、workerが1つも立たずに
  // 中身の無い結果を200で返すことになる。数として使う前に確かめる。
  if (concurrency !== undefined && concurrency !== null) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      throw { status: 400, message: `concurrency must be an integer from 1 to ${MAX_CONCURRENCY}` };
    }
  }
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw { status: 400, message: `items[${i}] must be an object` };
    }
    // idが無いと、失敗を記録する側がitem.idの参照で落ちる。
    if (typeof item.id !== 'string' || !item.id) {
      throw { status: 400, message: `items[${i}].id must be a non-empty string` };
    }
    try {
      validateQuestions(item.questions);
    } catch (err) {
      throw { status: 400, message: `items[${i}]: ${err?.message || 'invalid questions'}` };
    }
  });
}

export async function systemOneBatch(items, options = {}) {
  validateBatch(items, options.concurrency);

  const limit = Math.max(1, Math.min(options.concurrency || DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
  const results = new Array(items.length);
  let cursor = 0;

  // 中断は項目の失敗と分けて持つ。同じ扱いにすると、打鍵で中断したあとも
  // workerが残りの文を投げ続け、部分結果を200で返してしまう。
  let cancelled = null;

  const worker = async () => {
    while (cursor < items.length && !cancelled) {
      const i = cursor;
      cursor += 1;
      const item = items[i];
      const startedAt = Date.now();
      try {
        const r = await systemOne(item, options);
        results[i] = { id: item.id, ok: true, answers: r.answers, usage: r.usage, latencyMs: r.latencyMs, model: r.model };
      } catch (err) {
        if (err?.status === 499) { cancelled = err; return; }
        results[i] = { id: item.id, ok: false, latencyMs: Date.now() - startedAt, error: err?.message || 'Jev request failed' };
      }
    }
  };

  // allSettledで待つ。allだと最初の1本で抜けて、残りのworkerの例外が
  // 拾われないまま浮く。
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (cancelled) throw cancelled;

  // allSettledは例外を飲む。入力は検証済みなのでここに来ないはずだが、
  // 抜けた穴をそのまま200で返すと、呼び出し側がundefinedを読んで落ちる。
  const missing = results.findIndex((r) => r === undefined);
  if (missing !== -1) {
    throw { status: 500, message: `Jev batch left item ${missing} unanswered` };
  }
  return results;
}

/**
 * 疎通確認。モデル一覧は認証だけ確かめられればよいので判定は投げない。
 * @param {string} [clientKey] 利用者が画面から入れた鍵。無ければ環境変数を使う
 * @returns {Promise<true>}
 * @throws {{status: number, message: string}} 認証に失敗したとき
 */
export async function testJevConnection(clientKey) {
  const cfg = jevConfig();
  const apiKey = clientKey || cfg.apiKey;
  const { baseURL } = cfg;
  if (!apiKey) throw { status: 400, message: 'TYPESAFE_API_KEY is not set' };

  const res = await fetch(`${baseURL}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text();
    throw { status: res.status, message: `Jev: ${err}` };
  }
  return true;
}
