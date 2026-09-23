import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS, PROVIDERS, resolveDefaultModelId } from '../src/config/models.js';

// Geminiは選択肢から外した。一覧外の値はgpt-6-lunaに戻る
test('選択肢はOpenAIのgpt-6-lunaのみ', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['openai']);
  assert.deepEqual(AVAILABLE_MODELS.map((m) => m.id), ['gpt-6-luna']);
});

test('VITE_DEFAULT_MODELに外したGeminiのIDが残っていても既定に戻る', () => {
  assert.equal(resolveDefaultModelId('gemini-2.5-flash'), 'gpt-6-luna');
  assert.equal(resolveDefaultModelId(undefined), 'gpt-6-luna');
  assert.equal(resolveDefaultModelId('gpt-6-luna'), 'gpt-6-luna');
});
