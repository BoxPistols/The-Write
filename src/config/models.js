// 利用可能なモデル（料金: USD per 1M tokens）
// speed: 1-5 (5が最速), quality: 1-5 (5が最高品質)
export const PROVIDERS = {
  openai: { name: 'OpenAI', envKey: 'OPENAI_API_KEY' },
};

// secsPerKChar: 1000文字あたりの推定処理秒数（プログレス表示用）
export const AVAILABLE_MODELS = [
  // OpenAI
  { id: 'gpt-6-luna', provider: 'openai', name: 'GPT-6 Luna', description: '高品質・低価格', inputPrice: 0.10, outputPrice: 0.50, speed: 4, quality: 4, secsPerKChar: 5 },
];

/**
 * Auto Mode: 文字数とプロバイダー利用可否からモデルを自動選択
 * @param {number} charCount - テキスト文字数
 * @param {function} isAvailable - (providerId) => boolean
 * @returns {string} モデルID
 */
export function autoSelectModel(charCount, isAvailable) {
  // プロバイダー優先順（画面で選べるのはOpenAIのみ）
  const providerOrder = ['openai'];
  const available = providerOrder.find((p) => isAvailable(p));
  if (!available) return DEFAULT_MODEL_ID;

  const models = AVAILABLE_MODELS.filter((m) => m.provider === available);
  // 短文: 速度優先（speed最大）、長文: 品質優先（quality最大）
  const sorted = charCount <= 500
    ? [...models].sort((a, b) => b.speed - a.speed || a.inputPrice - b.inputPrice)
    : charCount <= 2000
    ? [...models].sort((a, b) => (b.speed + b.quality) - (a.speed + a.quality))
    : [...models].sort((a, b) => b.quality - a.quality || b.speed - a.speed);
  return sorted[0]?.id || DEFAULT_MODEL_ID;
}

// 何も指定が無いときに使うモデル。
const FALLBACK_MODEL_ID = 'gpt-6-luna';

/**
 * 既定モデルを決める。知らないidを渡されたら既定に戻す。
 * 綴り違いで黙って動かなくなるより、既定で動いたほうがよい。
 *
 * 画面（Vite）と ベンチ（Node）で読み先が違うので、値の取り出しは呼び出し側に任せ、
 * ここは決め方だけを持つ。同じ規則を2か所に書くと、片方だけ直したときにずれる。
 *
 * @param {string} [envValue] VITE_DEFAULT_MODEL の値
 */
export function resolveDefaultModelId(envValue) {
  return (envValue && AVAILABLE_MODELS.some((m) => m.id === envValue)) ? envValue : FALLBACK_MODEL_ID;
}

// .envで VITE_DEFAULT_MODEL を指定可能（例: VITE_DEFAULT_MODEL=gpt-6-luna）
// import.meta.env はViteが差し込むので、画面ではこれで読める。
export const DEFAULT_MODEL_ID = resolveDefaultModelId(
  typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DEFAULT_MODEL : undefined
);

export const getModel = (id) => AVAILABLE_MODELS.find((m) => m.id === id);
export const getProvider = (id) => getModel(id)?.provider;
export const getModelsByProvider = (provider) => AVAILABLE_MODELS.filter((m) => m.provider === provider);
