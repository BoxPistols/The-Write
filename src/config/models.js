// 利用可能なモデル（料金: USD per 1M tokens）
// speed: 1-5 (5が最速), quality: 1-5 (5が最高品質)
export const PROVIDERS = {
  openai: { name: 'OpenAI', envKey: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY' },
  gemini: { name: 'Google Gemini', envKey: 'GEMINI_API_KEY' },
};

// secsPerKChar: 1000文字あたりの推定処理秒数（プログレス表示用）
export const AVAILABLE_MODELS = [
  // OpenAI — nano/mini を優先
  { id: 'gpt-5-nano', provider: 'openai', name: 'GPT-5 Nano', description: '最速・最安', inputPrice: 0.05, outputPrice: 0.40, speed: 5, quality: 3, secsPerKChar: 8 },
  { id: 'gpt-5-mini', provider: 'openai', name: 'GPT-5 Mini', description: 'バランス型', inputPrice: 0.25, outputPrice: 2.00, speed: 4, quality: 4, secsPerKChar: 12 },
  { id: 'gpt-4.1-nano', provider: 'openai', name: 'GPT-4.1 Nano', description: '旧世代・最安', inputPrice: 0.10, outputPrice: 0.40, speed: 5, quality: 2, secsPerKChar: 3 },
  { id: 'gpt-4.1-mini', provider: 'openai', name: 'GPT-4.1 Mini', description: '旧世代・バランス', inputPrice: 0.40, outputPrice: 1.60, speed: 4, quality: 3, secsPerKChar: 5 },

  // Anthropic
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', name: 'Claude 4.5 Haiku', description: '最速・最安', inputPrice: 0.80, outputPrice: 4.00, speed: 5, quality: 3, secsPerKChar: 4 },
  { id: 'claude-sonnet-4-5-20250929', provider: 'anthropic', name: 'Claude 4.5 Sonnet', description: 'バランス型', inputPrice: 3.00, outputPrice: 15.00, speed: 3, quality: 4, secsPerKChar: 10 },

  // Google Gemini
  { id: 'gemini-2.5-flash', provider: 'gemini', name: 'Gemini 2.5 Flash', description: '最速・最安', inputPrice: 0.10, outputPrice: 0.40, speed: 5, quality: 3, secsPerKChar: 4 },
];

/**
 * Auto Mode: 文字数とプロバイダー利用可否からモデルを自動選択
 * @param {number} charCount - テキスト文字数
 * @param {function} isAvailable - (providerId) => boolean
 * @returns {string} モデルID
 */
export function autoSelectModel(charCount, isAvailable) {
  // プロバイダー優先順: openai > gemini > anthropic
  const providerOrder = ['openai', 'gemini', 'anthropic'];
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

// .envで VITE_DEFAULT_MODEL を指定可能（例: VITE_DEFAULT_MODEL=gpt-4.1-nano）
const envDefault = typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEFAULT_MODEL;
export const DEFAULT_MODEL_ID = (envDefault && AVAILABLE_MODELS.some((m) => m.id === envDefault)) ? envDefault : 'gemini-2.5-flash';

export const getModel = (id) => AVAILABLE_MODELS.find((m) => m.id === id);
export const getProvider = (id) => getModel(id)?.provider;
export const getModelsByProvider = (provider) => AVAILABLE_MODELS.filter((m) => m.provider === provider);
