import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'minimax/minimax-m2.5', name: 'Minimax M2.5' },
      { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash' },
      { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro' },
      { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1' },
      { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'openai/gpt-4o', name: 'GPT-4o' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'o3-mini', name: 'o3-mini' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问 (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen-long', name: 'Qwen Long' },
    ],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B' },
      { id: 'THUDM/glm-4-9b-chat', name: 'GLM-4 9B' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4-flash', name: 'GLM-4 Flash' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus' },
      { id: 'glm-4', name: 'GLM-4' },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'moonshot-v1-8k', name: 'Moonshot V1 8K' },
      { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K' },
      { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
    ],
  },
  {
    id: 'custom',
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    models: [],
  },
];

const DEFAULT_CONFIG = {
  provider: '',
  apiKey: '',
  baseUrl: '',
  model: '',
  customModels: [],
};

let _config = null;

export function loadConfig() {
  if (_config) return _config;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      _config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } else {
      _config = { ...DEFAULT_CONFIG };
    }
  } catch {
    _config = { ...DEFAULT_CONFIG };
  }
  return _config;
}

export function saveConfig(newConfig) {
  _config = { ...DEFAULT_CONFIG, ..._config, ...newConfig };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2), 'utf-8');
  } catch (err) {
    console.error('保存配置失败:', err.message);
  }
  return _config;
}

export function getConfig() {
  return loadConfig();
}

export function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg.apiKey && cfg.baseUrl && cfg.model);
}

export function getApiKey() {
  return loadConfig().apiKey || '';
}

export function getBaseUrl() {
  return loadConfig().baseUrl || '';
}

export function getCurrentModel() {
  return loadConfig().model || '';
}

export function setCurrentModel(modelId) {
  const cfg = loadConfig();
  cfg.model = modelId;
  saveConfig(cfg);
  console.log(`🤖 AI 模型已切换为: ${modelId}`);
  return true;
}

export function getAvailableModels() {
  const cfg = loadConfig();
  const provider = PROVIDERS.find(p => p.id === cfg.provider);
  const presetModels = provider?.models || [];
  const customModels = (cfg.customModels || []).map(m =>
    typeof m === 'string' ? { id: m, name: m } : m
  );
  return [...presetModels, ...customModels];
}

export function getSafeConfig() {
  const cfg = loadConfig();
  return {
    provider: cfg.provider,
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}****${cfg.apiKey.slice(-4)}` : '',
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    customModels: cfg.customModels || [],
    hasKey: !!cfg.apiKey,
  };
}
