import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENTENCE_QUESTIONS, REWRITE_QUESTIONS, AWKWARD_LEVELS, FLAG_THRESHOLD,
  verdictOf, gateOf,
} from '../src/config/jevQuestions.js';
import { validateQuestions } from '../api/_jev.js';

test('質問の形がAPIの契約を満たす', () => {
  validateQuestions(SENTENCE_QUESTIONS);
  validateQuestions(REWRITE_QUESTIONS);
  assert.ok(AWKWARD_LEVELS.length >= 2);
});

const answers = ({ awkward = 0, aiLike = 0, kind = 'none', conf = 0.9 }) => ({
  awkward: { type: 'score', score: awkward, confidence: conf },
  aiLike: { type: 'noul', noul: aiLike },
  kind: { type: 'choice', choice: kind, confidence: conf },
});

test('自然な文は指摘にしない', () => {
  const v = verdictOf(answers({ awkward: 0.3 }));
  assert.equal(v.flagged, false);
  assert.deepEqual(v.reason, []);
});

test('違和感が閾値を超えたら指摘にする', () => {
  const v = verdictOf(answers({ awkward: 2.4, kind: 'style' }));
  assert.equal(v.flagged, true);
  assert.equal(v.severity, 'warn');
  assert.equal(v.kind, 'style');
});

test('自然でもAIらしさが高ければ指摘にする', () => {
  const v = verdictOf(answers({ awkward: 0.4, aiLike: 0.82 }));
  assert.equal(v.flagged, true);
  assert.deepEqual(v.reason, ['aiLike']);
});

test('分布が割れている判定は指摘に格上げしない', () => {
  // 当てずっぽうと区別が付かない判定で下線を引くと、利用者が指摘を信じなくなる。
  const v = verdictOf(answers({ awkward: 3.2, conf: FLAG_THRESHOLD.confidence - 0.05 }));
  assert.equal(v.flagged, false);
  assert.equal(v.severity, 'error');
});

test('答えが欠けていても落ちない', () => {
  const v = verdictOf({});
  assert.equal(v.flagged, false);
  assert.equal(v.kind, 'none');
});

test('意味が変わった書き換えは、自然になっていても止める', () => {
  const g = gateOf({ improved: { noul: 0.95 }, meaningKept: { noul: 0.4 }, awkward: { score: 0.2 } });
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'meaning');
});

test('良くなっていない書き換えは採用しない', () => {
  const g = gateOf({ improved: { noul: 0.2 }, meaningKept: { noul: 0.99 }, awkward: { score: 1.8 } });
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'not-improved');
});

test('自然になり意味も保たれていれば採用する', () => {
  const g = gateOf({ improved: { noul: 0.8 }, meaningKept: { noul: 0.95 }, awkward: { score: 0.3 } });
  assert.equal(g.accept, true);
});
