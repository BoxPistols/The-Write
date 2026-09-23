// Jev(/v1/systemone)の代わりに立てる、判定を返すだけのサーバー。
//
// 実キーが無い場所で画面の挙動を確かめるためのもの。返す値はでたらめではなく、
// 本文から機械的に決めている。押すたびに色が変わると、下線やメーターの動きを
// 追えなくなるため。判定の質を見るものではないので、ベンチには使わない。
//
//   node tools/jev-stub.mjs &
//   TYPESAFE_API_KEY=stub TYPESAFE_BASE_URL=http://localhost:8787 npm run dev:server

import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT || 8787);
// 実物の体感に寄せた遅延。0にすると、打鍵に追従している実感が確かめられない。
const DELAY_MS = Number(process.env.STUB_DELAY_MS || 120);

const AI_MARKERS = ['することができます', 'いかがでしたでしょうか', 'ぜひ活用', '最適化', '羅針盤', 'また、', 'さらに、', 'そのため、'];

function judge(sentence) {
  const len = sentence.length;
  let awkward = 0;
  if (len > 60) awkward += 1.2;
  if (len > 100) awkward += 1.0;
  if ((sentence.match(/、/g) || []).length >= 4) awkward += 0.8;
  if (/がが|をを|はは|のの/.test(sentence)) awkward += 2.0;
  if (/です。.*です。.*です。/.test(sentence)) awkward += 0.8;
  const aiHits = AI_MARKERS.filter((m) => sentence.includes(m)).length;
  awkward += aiHits * 0.7;
  awkward = Math.min(4, Number(awkward.toFixed(2)));

  const kind = aiHits > 0 ? 'ai-writing'
    : /がが|をを|はは|のの/.test(sentence) ? 'grammar'
    : len > 60 ? 'clarity'
    : awkward >= 1.6 ? 'style'
    : 'none';

  return { awkward, aiLike: Math.min(0.95, aiHits * 0.45), kind };
}

const answerFor = (name, q, text) => {
  const j = judge(text);
  if (q.type === 'noul') {
    const yes = name === 'meaningKept' ? 0.93 : name === 'improved' ? 0.71 : j.aiLike;
    return { type: 'noul', noul: yes };
  }
  if (q.type === 'score') {
    const n = q.criteria.length;
    const probabilities = Object.fromEntries(q.criteria.map((_, i) => [i, i === Math.round(j.awkward) ? 0.7 : 0.3 / (n - 1)]));
    return { type: 'score', score: j.awkward, confidence: 0.78, legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])), probabilities };
  }
  const labels = Object.keys(q.criteria);
  const picked = labels.includes(j.kind) ? j.kind : labels[0];
  return {
    type: 'choice',
    choice: picked,
    confidence: 0.72,
    probabilities: Object.fromEntries(labels.map((l) => [l, l === picked ? 0.72 : 0.28 / (labels.length - 1)])),
  };
};

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([{ name: 'jev-stub', description: 'local stub', release_date: '2026-01-01' }]));
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/systemone')) {
    res.writeHead(404); return res.end();
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid json' }));
    }

    const state = payload.state;
    const text = typeof state === 'string'
      ? state
      : (state?.判定対象の文 || state?.書き換え後 || JSON.stringify(state ?? ''));

    const answers = Object.fromEntries(
      Object.entries(payload.questions || {}).map(([name, q]) => [name, answerFor(name, q, text)])
    );

    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'x-typesafe-request-id': `stub_${Date.now()}` });
      res.end(JSON.stringify({
        model: 'jev-stub',
        answers,
        usage: { input_tokens: Math.ceil(text.length / 2), output_tokens: Object.keys(answers).length },
      }));
    }, DELAY_MS);
  });
}).listen(PORT, () => console.log(`Jev stub on http://localhost:${PORT}`));
