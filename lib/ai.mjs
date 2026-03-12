import { getApiKey, getBaseUrl, getCurrentModel, isConfigured } from './config.mjs';

export { getCurrentModel, setCurrentModel, getAvailableModels } from './config.mjs';

export async function chatCompletion(messages, { temperature = 0.7, maxTokens = 1024, timeoutMs = 45000 } = {}) {
  if (!isConfigured()) {
    throw new Error('AI 未配置：请先在控制台「设置」中配置 API 密钥和模型');
  }

  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const model = getCurrentModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`AI API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      const diag = JSON.stringify({
        choicesLen: data.choices?.length,
        finishReason: data.choices?.[0]?.finish_reason,
        error: data.error,
      });
      console.warn(`[AI] 模型返回空内容: ${diag}`);
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_COARSE_PROMPT = `你是一个二手商品标题初筛助手。你只看标题，判断该商品是否与用户需求存在【明确冲突】。
判定规则：
- 只有标题内容和用户需求直接矛盾时才排除（例如：用户要笔记本，标题明确是手机壳/配件/维修/求购/租赁等完全不同的东西）
- 标题中没有提及的细节（成色、电池、价格、地区等）绝对不能作为排除理由
- 任何拿不准的情况一律保留，宁可多留不能误删`;

export const DEFAULT_FINE_PROMPT = `你是一个二手商品细筛助手。根据用户需求和商品详情页信息，判断该商品是否值得进一步沟通。
判定规则：
- 只有当商品信息与用户需求存在【明确冲突】时才不通过（例如：用户要求电池90%以上，详情明确写了电池80%）
- 商品描述中未提及的信息不算冲突，可以通过后续聊天了解
- 价格偏高不算冲突（可以砍价），只有远超合理范围才排除
- 拿不准的一律通过，宁可多聊不能错过`;

export async function judgeByTitle(titles, requirements, customPromptHead, emitLog) {
  const head = (customPromptHead && customPromptHead.trim()) ? customPromptHead.trim() : DEFAULT_COARSE_PROMPT;
  const prompt = `${head}

用户需求：${requirements}

商品列表（JSON数组）：
${JSON.stringify(titles.map((t, i) => ({ index: i, title: t })))}

请返回纯JSON数组，包含所有【没有明确冲突】的商品index（即应该保留的）。
只有标题和需求直接矛盾才排除，其余全部保留。
示例：[0, 1, 2, 3, 5, 7]
只输出JSON数组，不要有任何其他文字。`;

  if (emitLog) emitLog(`    [AI请求·粗筛] 需求="${requirements.slice(0, 60)}..." ${titles.length}个标题`);
  const reply = await chatCompletion([{ role: 'user', content: prompt }], { temperature: 0.1 });
  if (emitLog) emitLog(`    [AI返回·粗筛] ${reply.slice(0, 200)}`);

  if (!reply || !reply.trim()) {
    if (emitLog) emitLog(`    ⚠️ AI返回为空，保留本批全部`);
    return titles.map((_, i) => i);
  }

  try {
    const cleaned = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    const matches = reply.match(/\d+/g);
    return matches ? matches.map(Number) : titles.map((_, i) => i);
  }
}

export async function judgeByDetail(product, requirements, customPromptHead, emitLog) {
  const head = (customPromptHead && customPromptHead.trim()) ? customPromptHead.trim() : DEFAULT_FINE_PROMPT;
  const prompt = `${head}

用户需求：${requirements}

商品信息：
- 标题：${product.title}
- 价格：${product.price}
- 描述：${product.description}
- 卖家：${product.sellerName}（${product.sellerLocation}）
- 卖家好评率：${product.sellerRating || '未知'}
- 想要人数：${product.wantCount || '未知'}

请返回JSON格式：{"pass": true/false, "reason": "简短理由"}
判定标准：只有商品信息与需求存在明确冲突时pass为false，拿不准则pass为true。
不要输出任何额外文字。`;

  if (emitLog) emitLog(`    [AI请求·细筛] "${product.title.slice(0, 30)}..." 需求="${requirements.slice(0, 50)}..."`);
  const reply = await chatCompletion([{ role: 'user', content: prompt }], { temperature: 0.1 });
  if (emitLog) emitLog(`    [AI返回·细筛] ${reply.slice(0, 200)}`);
  try {
    const cleaned = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { pass: false, reason: '解析失败' };
  }
}

// ========== 聊天 prompt 三要素构建 ==========

export const DEFAULT_PERSONA = `你是一位活跃在闲鱼平台的买家。性格开朗、礼貌、真诚，说话自带"元气感"和"氛围感"的女大学生买家。你的核心目标是通过提供极高的情绪价值，让卖家产生"卖给你很开心"的心理，从而以更优惠的价格（谈价）或更优的条件（包邮/送小礼物）达成交易。

## Communication Style:
1. **语气词丰富：** 多用"哒、呀、呢、喔、呜呜、滴、哈罗"。
2. **表情包达人：** 灵活使用 Emoji（✨, 🥺, 🎈, 🥳, 💡, 🤏）。
3. **高情绪价值：** 进场先夸宝贝，中场卖萌示弱，收尾爽快礼貌。
4. **拒绝冷冰冰：** 禁止直接发数字（如"100？"），必须包装成有温度的请求。

核心沟通规则：
1. 每条消息严格不超过30个字
2. 一次回复可以发2-4条短消息，分条发送。而且除了信息交流外必须要能体现出礼貌可爱的人设
3. 语气活泼自然，像真人聊天，绝对不能像AI
4. 大量使用口语化表达和语气词（呀、哦、呢、嘻嘻、哈哈、嗯嗯）
5. 善用~代替句号，偶尔用表情（但不要每条都有）
6. 禁止一次性发送超过30字的长段落，会被识别为机器人
7. 回复节奏要像真人：先回应对方说的，再追问新问题

沟通流程（按优先级推进）：
- 先确认商品是否还在售
- 了解描述中未提及的信息和用户需求匹配度
- 进入谈价环节（根据下方谈价策略执行）
- 确认发货方式和时间

禁止行为：
- 不要自报家门说"我是XXX"
- 不要用书面语、不要太客气太正式
- 不要连续问多个问题，一次最多问两个个点`;

function buildChatStrategy(userStrategy, customPersona) {
  const persona = (customPersona && customPersona.trim()) ? customPersona.trim() : DEFAULT_PERSONA;

  const base = `【聊单策略 —— 你的人设与沟通方式】

${persona}`;

  if (!userStrategy) return base;

  return base + `

【本任务谈价策略 —— 议价时必须遵守】

${userStrategy}

执行要点：按上述策略灵活谈价，但不要生硬照搬策略原文。把策略内化为你自己的沟通节奏。`;
}

function buildProductContext(product) {
  const lines = [`【卖家发布的商品信息 —— 你正在咨询的这件商品】`];
  lines.push('');
  if (product.title) lines.push(`商品标题：${product.title}`);
  if (product.price || product.detailPrice) lines.push(`标价：${product.detailPrice || product.price}`);
  if (product.description) lines.push(`商品描述：${product.description}`);
  if (product.sellerName) lines.push(`卖家昵称：${product.sellerName}`);
  if (product.sellerLocation) lines.push(`卖家所在地：${product.sellerLocation}`);
  if (product.sellerRating) lines.push(`卖家好评率：${product.sellerRating}`);
  if (product.wantCount) lines.push(`想要人数：${product.wantCount}`);
  if (product.images?.length > 0) lines.push(`商品图片数量：${product.images.length}张`);
  return lines.join('\n');
}

function buildBuyerRequirements(requirements) {
  return `【采购需求 —— 你的真实购买意图，不要直接告诉卖家】

${requirements}

注意：以上是你内心的筛选标准，用于判断是否值得继续沟通。
不要把这些需求原封不动地告诉卖家，而是通过自然的提问来获取信息。`;
}

export function buildSessionPrompt(product, { requirements, chatStrategy, persona } = {}) {
  return [
    buildChatStrategy(chatStrategy, persona),
    '',
    buildProductContext(product),
    '',
    buildBuyerRequirements(requirements || ''),
    '',
    '【输出格式要求】',
    '返回纯JSON数组，每个元素是一条短消息字符串（≤15字）。',
    '例如：["你好呀~", "这个还在吗", "成色怎么样呢"]',
    '不要输出任何JSON以外的内容。',
  ].join('\n');
}

export async function judgeGoalReached(product, chatHistory, { requirements, chatStrategy, emitLog } = {}) {
  const recentHistory = chatHistory.slice(-20);
  const historyText = recentHistory.map(m => {
    const label = m.role === 'assistant' ? '我' : '卖家';
    return `${label}: ${m.content}`;
  }).join('\n');

  const goalContext = [];
  if (chatStrategy) goalContext.push(`谈价策略：${chatStrategy}`);
  if (requirements) goalContext.push(`采购需求：${requirements}`);

  const prompt = `你是一个聊天目标判定助手。根据以下信息判断这段买卖对话是否已经达成聊天目标。

达成目标的标准（满足任一即可）：
1. 卖家已同意在买家心理价位范围内成交（明确报出了可接受的价格或同意了买家的出价）
2. 买卖双方已确认交易细节（价格+发货方式），对话接近可以下单的状态
3. 卖家明确拒绝降价且态度坚决，继续谈判已无意义
4. 商品已售出/下架，卖家明确表示没货了

商品信息：
- 标题：${product.title}
- 标价：${product.detailPrice || product.price}

${goalContext.length > 0 ? goalContext.join('\n') : '（无特定策略）'}

对话记录：
${historyText}

请返回JSON格式：{"reached": true/false, "reason": "简短说明结论（20字以内）"}
不要输出任何额外文字。`;

  if (emitLog) emitLog(`    [AI请求·目标判定] "${product.title.slice(0, 25)}..." 近${recentHistory.length}条对话`);
  const reply = await chatCompletion([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 256 });
  if (emitLog) emitLog(`    [AI返回·目标判定] ${reply.slice(0, 200)}`);
  try {
    const cleaned = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { reached: false, reason: '判断失败' };
  }
}

export async function generateChatMessages(product, chatHistory, { requirements, chatStrategy, persona, emitLog } = {}) {
  const systemPrompt = buildSessionPrompt(product, { requirements, chatStrategy, persona });

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
  ];

  if (chatHistory.length === 0) {
    messages.push({
      role: 'user',
      content: '现在你刚点进这个商品的聊天页面，请生成开场白。2-3条短消息，先打招呼再自然地问一个关于商品的问题。',
    });
  } else {
    messages.push({
      role: 'user',
      content: '卖家刚刚回复了（见上方对话），请根据对方的回复自然地继续聊，1-3条短消息。',
    });
  }

  if (emitLog) emitLog(`    [AI请求·聊天] 历史${chatHistory.length}条 "${product.title.slice(0, 25)}..."`);
  const reply = await chatCompletion(messages, { temperature: 0.8, maxTokens: 512 });
  if (emitLog) emitLog(`    [AI返回·聊天] ${reply.slice(0, 200)}`);
  try {
    const cleaned = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter(m => typeof m === 'string' && m.length > 0 && m.length <= 20);
    }
    return [String(parsed)];
  } catch {
    const lines = reply.split('\n')
      .map(l => l.replace(/^[\s"'\d.、\-\[\]]+/, '').replace(/["\],]+$/, '').trim())
      .filter(l => l.length > 0 && l.length <= 20);
    return lines.length > 0 ? lines : ['你好呀~'];
  }
}
