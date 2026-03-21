import { newPage } from './browser.mjs';
import { generateChatMessages, buildSessionPrompt, judgeGoalReached } from './ai.mjs';
import { randomDelay, sleep, waitIfVerification } from './utils.mjs';

export class ChatManager {
  constructor(emitLog, shouldStop) {
    this.sessions = new Map();
    this.emitLog = emitLog;
    this.shouldStop = shouldStop;
    this._monitoring = false;
    // WebSocket 监控状态
    this._monitorPage = null;     // 常驻 IM 页面
    this._wsAlive = false;        // WS 连接是否存活
    this._wsReconnects = 0;       // 重连次数
    this._processingQueue = [];   // 消息处理队列（防并发）
    this._queueRunning = false;
    this._catchingUp = false;     // 补漏进行中（WS 消息只入队不处理）
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
          await randomDelay(2500, 4000);
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

  // ==================== 监控入口 ====================

  async monitorSessions() {
    if (this._monitoring) return;
    this._monitoring = true;
    this.emitLog('👀 开始监控聊天会话...');

    if (this.shouldStop()) {
      this._monitoring = false;
      this.emitLog(`👀 任务已被停止，聊天监控未启动（当前 ${this.sessions.size} 个会话已保存）`);
      return;
    }

    const waitingCount = [...this.sessions.values()].filter(s => s.status === 'waiting').length;
    if (waitingCount > 0) {
      this.emitLog(`  📊 共 ${this.sessions.size} 个会话（${waitingCount} 个待监控）`);
    }

    // 第一步：立即建立 WS（补漏期间消息只入队不处理）
    this._catchingUp = true;
    try {
      this.emitLog('🔌 建立 WebSocket 实时监听...');
      await this._setupWsMonitor();
    } catch (err) {
      this.emitLog(`  ⚠️ 初始 WS 连接失败: ${err.message}`);
    }

    // 第二步：对已有 waiting 会话做补漏
    await this._catchUpSessions();

    // 第三步：补漏完成，处理 WS 积压消息
    this._catchingUp = false;
    await this._drainDeferredQueue();

    // 第四步：进入 WS 监控主循环（含重连逻辑）
    await this._wsMonitorLoop();

    this._monitoring = false;
    await this._closeMonitorPage();
    if (this.shouldStop()) {
      this.emitLog(`👀 任务被手动停止，聊天监控结束（${this.sessions.size} 个会话已保存）`);
    } else {
      this.emitLog('👀 所有会话已结束，聊天监控停止');
    }
  }

  // ==================== 启动补漏：DOM 快照检查 ====================

  /**
   * 对所有 waiting 会话做一次性 DOM 快照，捕获停机/断连期间遗漏的消息。
   * 发现新消息的会话会触发 AI 回复。
   */
  async _catchUpSessions() {
    const waitingSessions = [...this.sessions.values()].filter(s => s.status === 'waiting');
    if (waitingSessions.length === 0) return;

    this.emitLog(`  🔄 补漏检查: ${waitingSessions.length} 个会话`);

    for (const session of waitingSessions) {
      if (this.shouldStop()) break;
      try {
        const hadNew = await this._checkSessionOnce(session);
        if (hadNew) {
          this.emitLog(`  📩 补漏发现新消息: ${session.product.title.slice(0, 20)}...`);
        }
      } catch (err) {
        this.emitLog(`  ⚠️ 补漏检查失败 ${session.id}: ${err.message}`);
      }
      await randomDelay(2000, 4000);
    }
    this.emitLog(`  🔄 补漏检查完成`);
  }

  /**
   * 单次 DOM 快照检查（用于补漏和降级），打开聊天页提取消息后关闭。
   * 如果有新的对方消息，触发 AI 回复。
   */
  async _checkSessionOnce(session) {
    const page = await newPage();
    let hadNewReply = false;
    const shortTitle = session.product.title.slice(0, 15);
    try {
      await page.goto(session.product.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const verifyOk = await this._checkAndWaitVerification(page, shortTitle);
      if (!verifyOk) return false;

      const loaded = await this._waitForChatReady(page, shortTitle);
      if (!loaded) return false;

      const pageMessages = await extractMessages(page);
      session.lastChecked = Date.now();

      const newOtherMsgs = pageMessages.filter(
        m => m.role === 'other' && !session.seenFingerprints.has(m.fingerprint)
      );

      if (newOtherMsgs.length > 0) {
        hadNewReply = true;
        for (const msg of newOtherMsgs) {
          session.seenFingerprints.add(msg.fingerprint);
          session.messages.push(msg);
          session.chatHistory.push({ role: 'user', content: msg.content });
          this.emitLog(`    收到: "${msg.content}"`);
        }

        // 同步自己的新消息
        const newSelfMsgs = pageMessages.filter(
          m => m.role === 'self' && !session.seenFingerprints.has(m.fingerprint)
        );
        for (const msg of newSelfMsgs) {
          session.seenFingerprints.add(msg.fingerprint);
          session.messages.push(msg);
          session.chatHistory.push({ role: 'assistant', content: msg.content });
        }

        // 判断目标 + AI 回复
        await this._handleNewIncoming(session, page);
      } else {
        this._syncSnapshot(session, pageMessages);
      }
    } finally {
      await page.close().catch(() => {});
    }
    return hadNewReply;
  }

  // ==================== WebSocket 实时监听 ====================

  /**
   * 主监控循环：打开 IM 页面，拦截 WS，断连时自动重连。
   */
  async _wsMonitorLoop() {
    const MAX_RECONNECTS = 10;

    while (!this.shouldStop()) {
      try {
        // 如果 WS 未连接，建立连接
        if (!this._wsAlive) {
          this.emitLog('🔌 重新建立 WebSocket 连接...');
          await this._setupWsMonitor();
        }

        // WS 已建立，进入等待循环
        while (!this.shouldStop() && this._wsAlive) {
          await sleep(3000);
          // 所有会话都结束了，退出
          if (!this._hasActiveSessions() && this.sessions.size > 0) break;
        }

        if (this.shouldStop()) break;
        if (!this._hasActiveSessions() && this.sessions.size > 0) break;

        // WS 断了，准备重连
        this._wsReconnects++;
        if (this._wsReconnects > MAX_RECONNECTS) {
          this.emitLog(`  ❌ WebSocket 重连次数超过 ${MAX_RECONNECTS}，停止监控`);
          break;
        }

        this.emitLog(`  🔄 WebSocket 断连，第 ${this._wsReconnects} 次重连...`);
        await this._closeMonitorPage();

        // 重连也遵循：先 WS 再补漏
        this._catchingUp = true;
        try {
          this.emitLog('🔌 建立 WebSocket 实时监听...');
          await this._setupWsMonitor();
        } catch (err) {
          this.emitLog(`  ⚠️ 重连 WS 失败: ${err.message}`);
        }
        await this._catchUpSessions();
        this._catchingUp = false;
        await this._drainDeferredQueue();

        await randomDelay(3000, 6000);

      } catch (err) {
        this.emitLog(`  ⚠️ WebSocket 监控异常: ${err.message}`);
        await this._closeMonitorPage();
        await sleep(5000);
      }
    }
  }

  /**
   * 打开 IM 页面并拦截 DingTalk IMPaaS WebSocket 连接。
   */
  async _setupWsMonitor() {
    this._wsAlive = false;
    const page = await newPage();
    this._monitorPage = page;

    // 在页面导航前注册 WS 监听
    page.on('websocket', ws => {
      const url = ws.url();
      // 只关注 DingTalk IMPaaS 连接
      if (!url.includes('wss-goofish.dingtalk.com')) return;

      this._wsAlive = true;
      this._wsReconnects = 0;
      this.emitLog('  ✅ WebSocket 连接已建立 (IMPaaS)');

      ws.on('framereceived', frame => {
        try {
          this._onWsFrame(frame.payload);
        } catch (err) {
          this.emitLog(`  ⚠️ WS 帧处理异常: ${err.message}`);
        }
      });

      ws.on('close', () => {
        this.emitLog('  ⚠️ WebSocket 连接已断开');
        this._wsAlive = false;
      });
    });

    // 监听页面崩溃/关闭
    page.on('crash', () => {
      this.emitLog('  ⚠️ 监控页面崩溃');
      this._wsAlive = false;
    });
    page.on('close', () => {
      this._wsAlive = false;
      this._monitorPage = null;
    });

    // 打开 IM 首页（会自动建立 WS 连接）
    await page.goto('https://www.goofish.com/im', { waitUntil: 'domcontentloaded', timeout: 30000 });

    const verifyOk = await this._checkAndWaitVerification(page, 'IM首页');
    if (!verifyOk) {
      throw new Error('IM 页面验证未通过');
    }

    // 等待 WS 连接建立
    const wsTimeout = 15000;
    const wsStart = Date.now();
    while (!this._wsAlive && Date.now() - wsStart < wsTimeout) {
      await sleep(500);
    }

    if (!this._wsAlive) {
      throw new Error('WebSocket 连接超时');
    }
  }

  /**
   * 处理收到的 WS 帧，提取 /s/sync bizType=40 的聊天消息。
   */
  _onWsFrame(payload) {
    if (typeof payload !== 'string') return;

    let frame;
    try { frame = JSON.parse(payload); } catch { return; }

    // 只关注服务端推送的 /s/sync 帧
    const lwp = frame.lwp || '';
    if (lwp !== '/s/sync') return;

    const body = frame.body;
    if (!body?.syncPushPackage?.data) return;

    for (const item of body.syncPushPackage.data) {
      // bizType 40 = 聊天消息
      if (item.bizType !== 40) continue;

      try {
        const binary = atob(item.data);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        const decoded = new TextDecoder('utf-8').decode(bytes);
        const msgInfo = this._parseWsMessage(decoded);
        if (msgInfo) {
          this._enqueueMessage(msgInfo);
        }
      } catch (err) {
        this.emitLog(`  ⚠️ 消息解码失败: ${err.message}`);
      }
    }
  }

  /**
   * 从 base64 解码后的二进制字符串中提取消息信息。
   * 数据格式：二进制协议中嵌入了 JSON 和可读字段。
   */
  _parseWsMessage(decoded) {
    // 提取 senderUserId
    const senderMatch = decoded.match(/senderUserId\x00?(.+?)(?:\x00|\x01)/);
    const senderUserId = senderMatch ? senderMatch[1].replace(/[^\d]/g, '') : '';

    // 提取消息内容 JSON
    const contentMatch = decoded.match(/\{"atUsers".*?"text":\{"text":"((?:[^"\\]|\\.)*)"\}\}/);
    const text = contentMatch ? contentMatch[1] : '';

    // 提取 reminderTitle（发送者昵称）
    const titleMatch = decoded.match(/reminderTitle\x00?(.+?)(?:\x00|\x01)/);
    const senderName = titleMatch ? titleMatch[1].replace(/[\x00-\x1f]/g, '').trim() : '';

    // 提取 itemId（从 reminderUrl）
    const itemIdMatch = decoded.match(/itemId=(\d+)/);
    const itemId = itemIdMatch ? itemIdMatch[1] : '';

    // 提取 peerUserId（从 reminderUrl）
    const peerMatch = decoded.match(/peerUserId=(\d+)/);
    const peerUserId = peerMatch ? peerMatch[1] : '';

    if (!text || !senderUserId) return null;

    return { senderUserId, text, senderName, itemId, peerUserId };
  }

  /**
   * 将 WS 消息加入处理队列（串行处理，防止并发回复冲突）。
   */
  _enqueueMessage(msgInfo) {
    this._processingQueue.push(msgInfo);
    if (this._catchingUp) return; // 补漏期间只入队，不触发处理
    if (!this._queueRunning) {
      this._queueRunning = true;
      this._processQueue().catch(err => {
        this.emitLog(`  ⚠️ 消息队列处理异常: ${err.message}`);
      }).finally(() => {
        this._queueRunning = false;
      });
    }
  }

  async _processQueue() {
    while (this._processingQueue.length > 0 && !this.shouldStop()) {
      const msgInfo = this._processingQueue.shift();
      await this._handleWsMessage(msgInfo);
    }
  }

  /**
   * 补漏完成后，统一处理积压的 WS 消息。
   * 去重会自动过滤已被补漏覆盖的消息。
   */
  async _drainDeferredQueue() {
    if (this._processingQueue.length === 0) return;
    this.emitLog(`  📬 处理补漏期间积压的 ${this._processingQueue.length} 条 WS 消息`);
    this._queueRunning = true;
    try {
      await this._processQueue();
    } finally {
      this._queueRunning = false;
    }
  }

  /**
   * 处理一条 WS 推送的消息：匹配会话 → 记录 → 判断目标 → AI 回复。
   */
  async _handleWsMessage(msgInfo) {
    const { senderUserId, text, senderName, itemId } = msgInfo;

    // 匹配会话：通过 chatUrl 中的 peerUserId 或 itemId
    let session = null;
    for (const s of this.sessions.values()) {
      if (s.status !== 'waiting') continue;
      const url = s.product.chatUrl || '';
      const urlPeer = extractUrlParam(url, 'peerUserId');
      const urlItem = extractUrlParam(url, 'itemId');
      if ((urlPeer && urlPeer === senderUserId) || (urlItem && urlItem === itemId)) {
        session = s;
        break;
      }
    }

    if (!session) return; // 不是我们监控的会话

    const shortTitle = session.product.title.slice(0, 20);
    this.emitLog(`  📩 [WS] ${shortTitle}... 收到消息: "${text}"`);

    // 去重
    const fp = msgFingerprint('other', text);
    if (session.seenFingerprints.has(fp)) {
      this.emitLog(`    ℹ️ 重复消息，跳过`);
      return;
    }

    session.seenFingerprints.add(fp);
    session.messages.push({ role: 'other', content: text, senderName, time: Date.now(), fingerprint: fp });
    session.chatHistory.push({ role: 'user', content: text });
    session.lastChecked = Date.now();

    // 打开聊天页回复
    const page = await newPage();
    try {
      await page.goto(session.product.chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const verifyOk = await this._checkAndWaitVerification(page, shortTitle);
      if (!verifyOk) {
        this.emitLog(`  ⚠️ ${shortTitle}... 回复页面验证失败`);
        return;
      }
      await this._waitForChatReady(page, shortTitle);
      await this._handleNewIncoming(session, page);
    } catch (err) {
      this.emitLog(`  ⚠️ ${shortTitle}... 回复失败: ${err.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ==================== 共用：目标判断 + AI 回复 ====================

  /**
   * 收到新消息后的通用处理：判断目标是否达成，未达成则生成 AI 回复。
   * page 参数为已打开的聊天页面（用于发送消息）。
   */
  async _handleNewIncoming(session, page) {
    const shortTitle = session.product.title.slice(0, 20);

    // 判断目标是否已达成
    if (session.chatHistory.length >= 6) {
      try {
        const goalResult = await judgeGoalReached(
          session.product, session.chatHistory, { ...session.chatContext, emitLog: this.emitLog }
        );
        if (goalResult.reached) {
          session.status = 'goal_reached';
          session.goalReason = goalResult.reason || '目标达成';
          this.emitLog(`  🎯 ${shortTitle}... 聊天目标达成: ${session.goalReason}`);
          return;
        }
      } catch (err) {
        this.emitLog(`    ⚠️ 目标判断出错: ${err.message}`);
      }
    }

    // 生成 AI 回复
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
      await randomDelay(2500, 4000);
    }
  }

  // ==================== 辅助方法 ====================

  _hasActiveSessions() {
    return [...this.sessions.values()].some(s => s.status === 'waiting');
  }

  async _closeMonitorPage() {
    if (this._monitorPage) {
      await this._monitorPage.close().catch(() => {});
      this._monitorPage = null;
    }
    this._wsAlive = false;
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
    await this._closeMonitorPage();
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
 * 从 URL 中提取指定参数值
 */
function extractUrlParam(url, param) {
  try {
    const u = new URL(url);
    return u.searchParams.get(param) || '';
  } catch {
    const match = url.match(new RegExp(`[?&]${param}=([^&]*)`));
    return match ? match[1] : '';
  }
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
