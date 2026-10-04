// 利用可能なモデル（料金: USD per 1M tokens）
// speed: 1-5 (5が最速), quality: 1-5 (5が最高品質)
export const PROVIDERS = {
  openai: { name: 'OpenAI', envKey: 'OPENAI_API_KEY' },
  gemini: { name: 'Google Gemini', envKey: 'GEMINI_API_KEY' },
};

// secsPerKChar: 1000文字あたりの推定処理秒数（プログレス表示用）
export const AVAILABLE_MODELS = [
  // OpenAI
  { id: 'gpt-5.6-luna', provider: 'openai', name: 'GPT-5.6 Luna', description: '高品質・低価格', inputPrice: 0.20, outputPrice: 1.20, speed: 4, quality: 4, secsPerKChar: 5 },

  // Google Gemini
  // 3.8が現行の最新Flash（2026-09-03にGAとして発表。docs/latest-model?hl=jaに
  // 「一般提供（GA）」と明記があり、gemini-flash-latestの解決先でもある）。
  // 3.6を併記するのは、無料枠が1日20回でプロジェクトとモデルごとに別勘定だから
  // （429のquotaIdがGenerateRequestsPerDayPerProjectPerModel-FreeTier、quotaValueが20）。
  // $0.75/$3.75は2026-12-31までの期間価格で、2027-01-01から$1.50/$7.50に戻る。
  { id: 'gemini-3.8-flash', provider: 'gemini', name: 'Gemini 3.8 Flash', description: '高速・大きなコンテキスト', inputPrice: 0.75, outputPrice: 3.75, speed: 5, quality: 5, secsPerKChar: 4 },
  { id: 'gemini-3.6-flash', provider: 'gemini', name: 'Gemini 3.6 Flash', description: '3.8の無料枠を使い切った日の代替', inputPrice: 0.75, outputPrice: 3.75, speed: 5, quality: 4, secsPerKChar: 4 },
];

/**
 * Auto Mode: 文字数とプロバイダー利用可否からモデルを自動選択
 * @param {number} charCount - テキスト文字数
 * @param {function} isAvailable - (providerId) => boolean
 * @returns {string} モデルID
 */
export function autoSelectModel(charCount, isAvailable) {
  // プロバイダー優先順: openai > gemini
  const providerOrder = ['openai', 'gemini'];
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

// .envで VITE_DEFAULT_MODEL を指定可能（例: VITE_DEFAULT_MODEL=gpt-5.6-luna）
const envDefault = typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEFAULT_MODEL;
export const DEFAULT_MODEL_ID = (envDefault && AVAILABLE_MODELS.some((m) => m.id === envDefault)) ? envDefault : 'gpt-5.6-luna';

export const getModel = (id) => AVAILABLE_MODELS.find((m) => m.id === id);
export const getProvider = (id) => getModel(id)?.provider;
export const getModelsByProvider = (provider) => AVAILABLE_MODELS.filter((m) => m.provider === provider);
