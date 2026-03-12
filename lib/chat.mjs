import { newPage } from './browser.mjs';
import { generateChatMessages, buildSessionPrompt, judgeGoalReached } from './ai.mjs';
import { randomDelay, sleep, waitIfVerification } from './utils.mjs';

export class ChatManager {
  constructor(emitLog, shouldStop) {
    this.sessions = new Map();
    this.emitLog = emitLog;
    this.shouldStop = shouldStop;
    this._monitoring = false;
  }

  async startChat(product, chatContext) {
    if (!product.chatUrl) {
      this.emitLog(`  ⚠️ 商品 "${product.title.slice(0, 20)}..." 没有聊天链接，跳过`);
      return null;
    }

    const sessionId = product.id;
    if (this.sessions.has(sessionId)) {
      this.emitLog(`  ℹ️ 已有会话: ${sessionId}`);
      return sessionId;
    }

    this.emitLog(`💬 发起聊天: ${product.title.slice(0, 30)}...`);

    const systemPrompt = buildSessionPrompt(product, chatContext);

    const session = {
      id: sessionId,
      product,
      chatContext,
      systemPrompt,
      messages: [],         // { role: 'self'|'other', content, time, fingerprint }
      chatHistory: [],      // { role: 'assistant'|'user', content } — for AI context
      seenFingerprints: new Set(),
      status: 'initiating',
      goalReason: '',
      lastChecked: Date.now(),
      backoffLevel: 0,
      page: null,
    };
    this.sessions.set(sessionId, session);

    try {
      const page = await newPage();
      session.page = page;

      const shortTitle = product.title.slice(0, 15);
      await page.goto(product.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const verifyOk = await this._checkAndWaitVerification(page, shortTitle);
      if (!verifyOk) {
        session.status = 'error';
        await page.close().catch(() => {});
        session.page = null;
        return null;
      }

      const loaded = await this._waitForChatReady(page, shortTitle);
      if (!loaded) {
        this.emitLog(`  ⚠️ 聊天页面加载不完整，尝试继续发送`);
      }

      // 先提取页面上已有的聊天记录，作为 AI 对话上下文
      const existingMessages = await extractMessages(page);
      this._syncSnapshot(session, existingMessages);

      if (existingMessages.length > 0) {
        this.emitLog(`  📋 检测到页面已有 ${existingMessages.length} 条聊天记录，作为上下文`);
      }

      // 判断是否需要发送消息：如果最后一条消息是自己发的且对方未回复，不再重复发送
      const lastMsg = session.messages[session.messages.length - 1];
      const needSend = !lastMsg || lastMsg.role === 'other';

      if (!needSend) {
        this.emitLog(`  ℹ️ 最后一条为自己发送的消息，等待对方回复，不重复发送`);
      } else {
        const msgs = await generateChatMessages(
          product, session.chatHistory, { ...chatContext, emitLog: this.emitLog }
        );
        this.emitLog(`  生成 ${msgs.length} 条消息`);

        for (const msg of msgs) {
          await this._sendMessage(page, msg);
          const fp = msgFingerprint('self', msg);
          session.messages.push({ role: 'self', content: msg, time: Date.now(), fingerprint: fp });
          session.chatHistory.push({ role: 'assistant', content: msg });
          session.seenFingerprints.add(fp);
          this.emitLog(`  📤 发送: "${msg}"`);
          await randomDelay(800, 2000);
        }

        // 发送后再次采集快照
        await sleep(2000);
        const postSendMessages = await extractMessages(page);
        this._syncSnapshot(session, postSendMessages);
      }

      session.status = 'waiting';
      session.lastChecked = Date.now();
      await page.close().catch(() => {});
      session.page = null;

      this.emitLog(`  ✅ 开场消息已发送，等待回复（快照 ${session.messages.length} 条消息）`);
      return sessionId;
    } catch (err) {
      this.emitLog(`  ❌ 聊天发起失败: ${err.message}`);
      session.status = 'error';
      if (session.page) await session.page.close().catch(() => {});
      session.page = null;
      return null;
    }
  }

  /**
   * 同步页面快照到 session：基于内容指纹做去重，
   * 只把尚未见过的消息追加到 session.messages 和 chatHistory
   */
  _syncSnapshot(session, pageMessages) {
    let newCount = 0;
    for (const pm of pageMessages) {
      if (session.seenFingerprints.has(pm.fingerprint)) continue;
      session.seenFingerprints.add(pm.fingerprint);
      session.messages.push(pm);
      session.chatHistory.push({
        role: pm.role === 'self' ? 'assistant' : 'user',
        content: pm.content,
      });
      newCount++;
    }
    return newCount;
  }

  async _sendMessage(page, text) {
    // 闲鱼 IM 输入框: textarea with placeholder containing "请输入消息"
    const inputSel = 'textarea[class*="textarea-no-border"], textarea[placeholder*="请输入消息"]';
    const inputEl = page.locator(inputSel).first();

    const visible = await inputEl.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      this.emitLog('    ⚠️ 未找到聊天输入框');
      return;
    }

    await inputEl.click();
    await sleep(300);

    // 清空已有内容后输入
    await inputEl.fill('');
    await sleep(100);
    for (const char of text) {
      await inputEl.type(char, { delay: 30 + Math.random() * 60 });
    }
    await sleep(500);

    // 闲鱼发送按钮: "发 送" (注意中间有空格)
    const sendBtn = page.locator('button:has-text("发 送"), button:has-text("发送")').first();
    const btnVisible = await sendBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (btnVisible) {
      await sendBtn.click();
      await sleep(500);
      return;
    }

    // 备选：按回车
    await page.keyboard.press('Enter');
    await sleep(500);
  }

  async _waitForChatReady(page, label = '') {
    const prefix = label ? `[${label}] ` : '';
    try {
      await page.waitForSelector('#message-list-scrollable', { timeout: 15000 });
    } catch {
      this.emitLog(`  ${prefix}⚠️ 消息列表15s内未加载，继续等待...`);
      try {
        await page.waitForSelector('#message-list-scrollable', { timeout: 20000 });
      } catch {
        this.emitLog(`  ${prefix}⚠️ 消息列表加载超时，尝试继续`);
        return false;
      }
    }
    await sleep(1500);

    await page.evaluate(() => {
      const el = document.querySelector('#message-list-scrollable');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await sleep(800);
    return true;
  }

  async _checkAndWaitVerification(page, label = '') {
    return waitIfVerification(page, {
      emitLog: this.emitLog,
      shouldStop: this.shouldStop,
      label,
    });
  }

  _getCheckInterval(session) {
    const INTERVALS = [16, 60, 180, 600, 3600];
    const base = INTERVALS[Math.min(session.backoffLevel, INTERVALS.length - 1)];
    const jitter = Math.floor(Math.random() * 15) + 1;
    return (base + jitter) * 1000;
  }

  async monitorSessions() {
    if (this._monitoring) return;
    this._monitoring = true;
    this.emitLog('👀 开始监控聊天会话...');

    if (this.shouldStop()) {
      this._monitoring = false;
      this.emitLog(`👀 任务已被停止，聊天监控未启动（当前 ${this.sessions.size} 个会话已保存）`);
      return;
    }

    if (this.sessions.size === 0) {
      this._monitoring = false;
      this.emitLog('👀 无活跃会话，聊天监控结束');
      return;
    }

    const waitingCount = [...this.sessions.values()].filter(s => s.status === 'waiting').length;
    this.emitLog(`  📊 共 ${this.sessions.size} 个会话（${waitingCount} 个待监控）`);

    while (!this.shouldStop() && this.sessions.size > 0) {
      const activeSessions = [...this.sessions.values()].filter(s => s.status === 'waiting');
      let anyChecked = false;

      for (const session of activeSessions) {
        if (this.shouldStop()) break;

        const interval = this._getCheckInterval(session);
        const elapsed = Date.now() - session.lastChecked;
        if (elapsed < interval) continue;

        try {
          const hadNewReply = await this._checkSession(session);
          if (hadNewReply) {
            session.backoffLevel = 0;
          } else {
            session.backoffLevel = Math.min(session.backoffLevel + 1, 4);
          }
          const nextInterval = this._getCheckInterval(session);
          this.emitLog(`  ⏱️ ${session.product.title.slice(0, 15)}... 下次检查: ${Math.round(nextInterval / 1000)}s后`);
        } catch (err) {
          this.emitLog(`  ⚠️ 检查会话 ${session.id} 失败: ${err.message}`);
        }

        anyChecked = true;
        await randomDelay(2000, 5000);
      }

      await sleep(anyChecked ? 3000 : 5000);
    }

    this._monitoring = false;
    if (this.shouldStop()) {
      this.emitLog(`👀 任务被手动停止，聊天监控结束（${this.sessions.size} 个会话已保存）`);
    } else {
      this.emitLog('👀 所有会话已结束，聊天监控停止');
    }
  }

  async _checkSession(session) {
    const page = await newPage();
    let hadNewReply = false;
    const shortTitle = session.product.title.slice(0, 15);
    try {
      await page.goto(session.product.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const verifyOk = await this._checkAndWaitVerification(page, shortTitle);
      if (!verifyOk) {
        this.emitLog(`  ⚠️ ${shortTitle}... 校验未通过，跳过本轮检查`);
        return false;
      }

      const loaded = await this._waitForChatReady(page, shortTitle);
      if (!loaded) {
        this.emitLog(`  ⚠️ ${shortTitle}... 聊天页面加载不完整，跳过本轮`);
        return false;
      }

      const pageMessages = await extractMessages(page);
      session.lastChecked = Date.now();

      const newOtherMsgs = pageMessages.filter(
        m => m.role === 'other' && !session.seenFingerprints.has(m.fingerprint)
      );

      if (newOtherMsgs.length > 0) {
        hadNewReply = true;
        this.emitLog(`  📩 ${session.product.title.slice(0, 20)}... 收到 ${newOtherMsgs.length} 条新消息`);

        for (const msg of newOtherMsgs) {
          session.seenFingerprints.add(msg.fingerprint);
          session.messages.push(msg);
          session.chatHistory.push({ role: 'user', content: msg.content });
          this.emitLog(`    收到: "${msg.content}"`);
        }

        const newSelfMsgs = pageMessages.filter(
          m => m.role === 'self' && !session.seenFingerprints.has(m.fingerprint)
        );
        for (const msg of newSelfMsgs) {
          session.seenFingerprints.add(msg.fingerprint);
          session.messages.push(msg);
          session.chatHistory.push({ role: 'assistant', content: msg.content });
        }

        // 先判断目标是否已达成（至少有4轮对话后才判断）
        if (session.chatHistory.length >= 6) {
          try {
            const goalResult = await judgeGoalReached(
              session.product, session.chatHistory, { ...session.chatContext, emitLog: this.emitLog }
            );
            if (goalResult.reached) {
              session.status = 'goal_reached';
              session.goalReason = goalResult.reason || '目标达成';
              this.emitLog(`  🎯 ${session.product.title.slice(0, 20)}... 聊天目标达成: ${session.goalReason}`);
              return hadNewReply;
            }
          } catch (err) {
            this.emitLog(`    ⚠️ 目标判断出错: ${err.message}`);
          }
        }

        const replies = await generateChatMessages(
          session.product,
          session.chatHistory,
          { ...session.chatContext, emitLog: this.emitLog },
        );

        for (const reply of replies) {
          await this._sendMessage(page, reply);
          const fp = msgFingerprint('self', reply);
          session.seenFingerprints.add(fp);
          session.messages.push({ role: 'self', content: reply, time: Date.now(), fingerprint: fp });
          session.chatHistory.push({ role: 'assistant', content: reply });
          this.emitLog(`    📤 回复: "${reply}"`);
          await randomDelay(800, 2000);
        }
      } else {
        this._syncSnapshot(session, pageMessages);
      }
    } finally {
      await page.close().catch(() => {});
    }
    return hadNewReply;
  }

  getSessionsData() {
    const data = [];
    for (const [id, session] of this.sessions) {
      data.push({
        id,
        productTitle: session.product.title,
        productPrice: session.product.price,
        productDescription: session.product.description?.slice(0, 200) || '',
        sellerName: session.product.sellerName || '',
        status: session.status,
        goalReason: session.goalReason || '',
        messageCount: session.messages.length,
        messages: session.messages.slice(-30).map(m => ({
          role: m.role,
          content: m.content,
          time: m.time,
        })),
        lastChecked: session.lastChecked,
        promptSummary: {
          hasStrategy: !!session.chatContext?.chatStrategy,
          hasProductContext: !!session.product.description,
          hasRequirements: !!session.chatContext?.requirements,
        },
      });
    }
    return data;
  }

  getSessionsFullData() {
    const data = [];
    for (const [id, session] of this.sessions) {
      data.push({
        id,
        product: session.product,
        chatContext: session.chatContext,
        status: session.status,
        goalReason: session.goalReason || '',
        messages: session.messages.map(m => ({
          role: m.role,
          content: m.content,
          time: m.time,
          fingerprint: m.fingerprint,
        })),
        chatHistory: session.chatHistory,
        lastChecked: session.lastChecked,
        backoffLevel: session.backoffLevel,
      });
    }
    return data;
  }

  restoreSessions(savedSessions, chatContext) {
    let restored = 0;
    for (const s of savedSessions) {
      if (s.status === 'goal_reached' || s.status === 'error') continue;
      if (!s.product?.chatUrl) continue;

      const ctx = s.chatContext || chatContext;
      const systemPrompt = buildSessionPrompt(s.product, ctx);

      const seenFingerprints = new Set();
      const messages = (s.messages || []).map(m => {
        const fp = m.fingerprint || msgFingerprint(m.role, m.content);
        seenFingerprints.add(fp);
        return { ...m, fingerprint: fp };
      });

      let chatHistory = s.chatHistory;
      if (!chatHistory || chatHistory.length === 0) {
        chatHistory = messages.map(m => ({
          role: m.role === 'self' ? 'assistant' : 'user',
          content: m.content,
        }));
      }

      const session = {
        id: s.id,
        product: s.product,
        chatContext: ctx,
        systemPrompt,
        messages,
        chatHistory,
        seenFingerprints,
        status: 'waiting',
        goalReason: s.goalReason || '',
        lastChecked: Date.now(),
        backoffLevel: 0,
        page: null,
      };
      this.sessions.set(s.id, session);
      restored++;
    }
    if (restored > 0) {
      this.emitLog(`  ♻️ 从持久化数据恢复了 ${restored} 个聊天会话`);
    }
    return restored;
  }

  async cleanup() {
    for (const session of this.sessions.values()) {
      if (session.page) await session.page.close().catch(() => {});
    }
    this.sessions.clear();
  }
}

/**
 * 生成消息指纹，用于去重（同一角色+同样文本 = 同一条消息）
 * 加入序号后缀处理同一人连续发相同内容的情况
 */
function msgFingerprint(role, content) {
  return `${role}:${content.trim()}`;
}

/**
 * 在闲鱼 IM 页面上精确提取所有消息。
 * 
 * DOM 结构关键点：
 * - 消息列表在 #message-list-scrollable > .ant-list-items 下
 * - 每条消息是 li.ant-list-item
 * - 自己的消息: li 的 style 含 "direction: rtl"，文本 class 含 "message-text-right"
 * - 对方的消息: li 的 style 含 "direction: ltr"，文本 class 含 "message-text-left"
 * - 发送者名称在 message-row 内第一个小字体 div
 * - 消息文本在 div[class*="message-text"] 的 span 中
 */
async function extractMessages(page) {
  return page.evaluate(() => {
    const results = [];
    const roleCounters = {};

    const msgRows = document.querySelectorAll('[class*="message-row"]');

    for (const row of msgRows) {
      const li = row.closest('li');
      if (!li) continue;

      const liStyle = li.getAttribute('style') || '';
      let role;
      if (liStyle.includes('direction: rtl') || liStyle.includes('direction:rtl')) {
        role = 'self';
      } else if (liStyle.includes('direction: ltr') || liStyle.includes('direction:ltr')) {
        role = 'other';
      } else {
        // 备用判断：检查 message-text 的 class
        const textEl = row.querySelector('[class*="message-text"]');
        if (!textEl) continue;
        const cls = textEl.className || '';
        if (cls.includes('right')) {
          role = 'self';
        } else if (cls.includes('left')) {
          role = 'other';
        } else {
          continue;
        }
      }

      // 提取发送者名称
      // 在 message-row 内，sender name 是 font-size: 12px 的那个 div
      let senderName = '';
      const allDivs = row.querySelectorAll('div');
      for (const d of allDivs) {
        const s = d.getAttribute('style') || '';
        if (s.includes('font-size: 12px') && s.includes('color: rgb(102, 102, 102)')) {
          senderName = d.textContent.trim();
          break;
        }
      }

      // 提取消息文本
      const textEl = row.querySelector('[class*="message-text"]');
      if (!textEl) continue;

      // 文本可能在 span 子元素中，或直接是 textContent
      const spans = textEl.querySelectorAll('span');
      let content = '';
      if (spans.length > 0) {
        content = [...spans].map(s => s.textContent.trim()).join('');
      }
      if (!content) {
        content = textEl.textContent.trim();
      }

      if (!content || content.length > 500) continue;

      // 处理同一 role 连续发同内容消息的去重序号
      const baseKey = `${role}:${content}`;
      roleCounters[baseKey] = (roleCounters[baseKey] || 0) + 1;
      const count = roleCounters[baseKey];
      const fingerprint = count > 1 ? `${baseKey}#${count}` : baseKey;

      results.push({
        role,
        content,
        senderName,
        fingerprint,
        time: Date.now(),
      });
    }

    return results;
  });
}
