// 入力中に文単位でJevへ判定を出し、違和感の度合いを本文に追従させる。
//
// 生成モデルで同じことをすると1000文字で4〜5秒かかり、打鍵に追いつかない。
// Jevは文章を作らないので1文の判定が桁で速く、そのうえ内容が変わった文だけを
// 投げ直せば、打鍵1回あたりの往復はたいてい1件で済む。
//
// 判定の組み立てと畳み方はsrc/utils/jevTriageCore.jsにある。ここは
// 打鍵との付き合い方（デバウンス、取り消し、部分反映）だけを持つ。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { splitSentences } from '../utils/sentences.js';
import {
  makeVerdictCache, planJudgements, chunk, summarize, triageScope, CHUNK_SIZE,
} from '../utils/jevTriageCore.js';
import { judgeSentences } from '../utils/jevClient.js';

// 打鍵が止まったとみなすまでの待ち。短くすると judging の点滅が増え、
// 長くすると「書いた直後に反応しない」と感じる。
const DEBOUNCE_MS = 300;

// 1回の走りで投げ直す文の上限。長文を貼られたときに数百件を一度に出さない。
// 余りは次の走りで拾う。先に判定した文はキャッシュに入るので、走るたびに前へ進む。
const MAX_PER_RUN = 96;

/**
 * @param {string} text 本文（プレーンテキスト）
 * @param {{enabled?: boolean, purpose?: string, clientKeys?: object}} [options]
 */
export function useJevTriage(text, { enabled = true, purpose = '', clientKeys } = {}) {
  const cacheRef = useRef(makeVerdictCache());
  const runIdRef = useRef(0);
  const abortRef = useRef(null);

  const [verdicts, setVerdicts] = useState(() => new Map());
  const [status, setStatus] = useState('idle'); // idle | judging | ready | error
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ ttffMs: null, lastWallMs: null, judged: 0, cacheHits: 0 });

  const sentences = useMemo(() => splitSentences(text || ''), [text]);
  const units = useMemo(() => planJudgements(sentences, cacheRef.current, purpose).units, [sentences, purpose]);

  const run = useCallback(async () => {
    const runId = runIdRef.current;
    const cache = cacheRef.current;
    const plan = planJudgements(splitSentences(text || ''), cache, purpose);

    // 手元にある判定をまず画面へ返す。ここで返さないと、文を消しただけでも
    // 判定が消えたように見える。
    const settle = () => {
      if (runIdRef.current !== runId) return;
      setVerdicts(new Map(plan.units.map((u) => [u.key, cache.get(u.key)]).filter(([, v]) => v)));
    };
    settle();

    if (!plan.toJudge.length) {
      if (runIdRef.current === runId) setStatus(plan.units.length ? 'ready' : 'idle');
      return;
    }

    setStatus('judging');
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = performance.now();
    let ttffMs = null;
    let judged = 0;

    try {
      for (const batch of chunk(plan.toJudge.slice(0, MAX_PER_RUN), CHUNK_SIZE)) {
        const { results } = await judgeSentences(
          batch.map((u) => ({ id: u.key, text: u.text, before: u.before, after: u.after })),
          { purpose, clientKeys, signal: controller.signal }
        );

        // 打鍵で追い越されていたら、届いた判定は捨てる。古い本文の判定を
        // 新しい本文に重ねると、直したはずの文に下線が残る。
        if (runIdRef.current !== runId) return;

        for (const r of results) {
          if (r.ok) { cache.set(r.id, r.verdict); judged += 1; }
        }
        // 塊ごとに返す。全部揃うのを待つと、長文で最初の下線が出るまで固まる。
        if (ttffMs === null) ttffMs = Math.round(performance.now() - startedAt);
        settle();
      }

      if (runIdRef.current !== runId) return;
      setStats({ ttffMs, lastWallMs: Math.round(performance.now() - startedAt), judged, cacheHits: plan.cachedCount });
      setStatus('ready');

      // 上限で切った残りは、間を置かずに続きを拾う。ただし前へ進んだときだけ。
      //
      // 進み具合を数え直さずに続けると、止まらない輪になる。失敗した文は
      // キャッシュに入らないので同じ残りを投げ直し続けるし、文の種類が
      // キャッシュの上限を超える長文でも、古い判定が押し出されて残りが減らない。
      // どちらも画面は何も変わらないまま上流を叩き続ける。
      if (plan.toJudge.length > MAX_PER_RUN) {
        const left = planJudgements(splitSentences(text || ''), cache, purpose).toJudge.length;
        if (left < plan.toJudge.length) run();
      }
    } catch (e) {
      if (runIdRef.current !== runId || controller.signal.aborted) return;
      console.error('Jev triage failed:', e);
      setError(e.message || String(e));
      setStatus('error');
    }
  }, [text, purpose, clientKeys]);

  useEffect(() => {
    // 走りを先に1つ進める。進めた時点で、走っている古い処理は自分で降りる。
    // 早期returnの後ろに置くと、本文を消した瞬間に走っていた判定が生き残り、
    // もう無い文の下線を書き戻してreadyにしてしまう。
    runIdRef.current += 1;
    abortRef.current?.abort();

    if (!enabled) { setStatus('idle'); return undefined; }
    if (!(text || '').trim()) { setStatus('idle'); setVerdicts(new Map()); return undefined; }

    const timer = setTimeout(run, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, enabled, run]);

  useEffect(() => () => { runIdRef.current += 1; abortRef.current?.abort(); }, []);

  const summary = useMemo(() => summarize(units, verdicts), [units, verdicts]);

  /** 生成モデルへ送る範囲。指摘の立った文だけに絞る。 */
  const scope = useCallback(() => triageScope(units, verdicts, text || ''), [units, verdicts, text]);

  /** 閾値や質問を変えたあと、手元の判定を捨てて取り直す。 */
  const reset = useCallback(() => {
    cacheRef.current.clear();
    setVerdicts(new Map());
    setStatus('idle');
  }, []);

  // 返す入れ物を毎回作り直さない。呼び出し側がこれを依存に入れたとき、
  // 中身が変わっていないのに再実行されるのを避ける。
  return useMemo(
    () => ({ units, verdicts, summary, status, error, stats, scope, reset }),
    [units, verdicts, summary, status, error, stats, scope, reset]
  );
}
