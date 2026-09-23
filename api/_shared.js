import { hasJevKey, testJevConnection } from './_jev.js';

const ENV_KEYS = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  // Jevは文章を書かないので生成モデルの一覧には出さないが、
  // 鍵の有無と疎通確認は他のプロバイダーと同じ窓口から見せる。
  jev: 'TYPESAFE_API_KEY',
};

export function setCorsHeaders(res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function getProvider(modelId) {
  if (modelId?.startsWith('gpt-') || modelId?.startsWith('o1') || modelId?.startsWith('o3') || modelId?.startsWith('o4')) return 'openai';
  if (modelId?.startsWith('gemini-')) return 'gemini';
  return null;
}

export function getAvailableProviders() {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    jev: hasJevKey(),
  };
}

export function resolveKey(provider, clientKeys) {
  return clientKeys?.[provider] || process.env[ENV_KEYS[provider]] || null;
}

async function callOpenAI(model, messages, apiKey, maxTokens) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  // 推論分の不可視トークンで回答が途中で尽きないよう上限は余裕を持たせる
  const defaultMax = 16000;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens || defaultMax,
      messages,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`[OpenAI] ${response.status} ${response.statusText}:`, errBody);
    throw { status: response.status, message: `OpenAI error ${response.status}: ${errBody}` };
  }

  const data = await response.json();
  return {
    content: [{ type: 'text', text: data.choices?.[0]?.message?.content || '' }],
    model: data.model,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

async function callGemini(model, messages, apiKey, maxTokens) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: maxTokens || 16000 },
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`[Gemini] ${response.status} ${response.statusText}:`, errBody);
    throw { status: response.status, message: `Gemini error ${response.status}: ${errBody}` };
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  return {
    content: [{ type: 'text', text }],
    model,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

export async function testConnection(provider, apiKey) {
  if (!apiKey) throw { status: 400, message: 'API key not provided' };

  switch (provider) {
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        const err = await res.text();
        throw { status: res.status, message: `OpenAI: ${err}` };
      }
      return true;
    }
    case 'gemini': {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
      );
      if (!res.ok) {
        const err = await res.text();
        throw { status: res.status, message: `Gemini: ${err}` };
      }
      return true;
    }
    case 'jev':
      return testJevConnection(apiKey);
    default:
      throw { status: 400, message: `Unknown provider: ${provider}` };
  }
}

export async function analyzeRequest({ model, messages, clientKeys, maxTokens } = {}) {
  const provider = getProvider(model);
  if (!provider) {
    throw { status: 400, message: `Unknown model: ${model}` };
  }

  const apiKey = resolveKey(provider, clientKeys);
  if (!apiKey) {
    throw { status: 401, message: `API key not configured for provider: ${provider}` };
  }

  switch (provider) {
    case 'openai':
      return callOpenAI(model, messages, apiKey, maxTokens);
    case 'gemini':
      return callGemini(model, messages, apiKey, maxTokens);
    default:
      throw { status: 400, message: `Unknown model: ${model}` };
  }
}
