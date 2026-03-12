// ========== State ==========
let ws = null;
let tasks = [];
let activeTaskId = null;
let defaultPersona = '';
let defaultCoarsePrompt = '';
let defaultFinePrompt = '';
let providers = [];
let currentConfig = {};
let customModels = [];

const STAGE_LABELS = {
  pending: '等待中',
  login: '登录验证',
  searching: '搜索采集',
  coarse_filter: '粗筛',
  fine_filter: '细筛',
  chatting: '询价中',
  completed: '已完成',
  stopped: '已停止',
  stopping: '停止中',
};

const STAGES_ORDER = ['login', 'searching', 'coarse_filter', 'fine_filter', 'chatting'];

// ========== WebSocket ==========
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    document.getElementById('ws-status').classList.add('connected');
  };

  ws.onclose = () => {
    document.getElementById('ws-status').classList.remove('connected');
    setTimeout(connectWS, 2000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  };
}

function handleWSMessage(msg) {
  const { event, taskId, data } = msg;

  switch (event) {
    case 'connected':
      if (data?.tasks) {
        tasks = data.tasks;
        renderTaskList();
      }
      if (data?.configured === false) {
        showConfigBanner();
      } else {
        hideConfigBanner();
      }
      break;

    case 'task:created':
      tasks.push(data);
      renderTaskList();
      selectTask(data.id);
      break;

    case 'task:started':
    case 'task:stopping':
      updateTaskField(taskId, 'running', event === 'task:started');
      if (event === 'task:stopping') updateTaskField(taskId, 'stage', 'stopping');
      renderTaskList();
      if (activeTaskId === taskId) renderPipeline();
      break;

    case 'task:stage':
      updateTaskField(taskId, 'stage', data.stage);
      renderTaskList();
      if (activeTaskId === taskId) renderPipeline();
      break;

    case 'task:log':
      appendLog(taskId, data);
      break;

    case 'task:products':
      updateProductCounts(taskId, data);
      if (activeTaskId === taskId) renderProductStats();
      break;

    case 'task:chats':
      updateTaskField(taskId, 'chatSessions', data);
      if (activeTaskId === taskId) renderChats();
      break;

    case 'task:finished':
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx >= 0) tasks[idx] = data;
      renderTaskList();
      if (activeTaskId === taskId) renderTaskDetail();
      break;

    case 'model:changed':
      if (data?.current) {
        const select = document.getElementById('model-select');
        if (select) select.value = data.current;
      }
      break;

    case 'config:changed':
      if (data?.configured) {
        hideConfigBanner();
      } else {
        showConfigBanner();
      }
      if (data?.config) {
        currentConfig = data.config;
      }
      loadModel();
      break;
  }
}

function updateTaskField(taskId, field, value) {
  const task = tasks.find(t => t.id === taskId);
  if (task) task[field] = value;
}

function updateProductCounts(taskId, data) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.products) task.products = {};
  task.products.rawCount = data.rawCount;
  task.products.coarseCount = data.coarseCount;
  task.products.fineCount = data.fineCount;
}

function appendLog(taskId, entry) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.logs) task.logs = [];
  task.logs.push(entry);
  if (task.logs.length > 500) task.logs = task.logs.slice(-300);

  if (activeTaskId === taskId) {
    const panel = document.getElementById('log-panel');
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `<span class="log-time">${entry.time}</span>${escapeHtml(entry.message)}`;
    panel.appendChild(div);
    panel.scrollTop = panel.scrollHeight;
  }
}

// ========== Config Banner ==========
function showConfigBanner() {
  document.getElementById('config-banner').style.display = 'flex';
  document.getElementById('settings-btn').classList.add('pulse');
}

function hideConfigBanner() {
  document.getElementById('config-banner').style.display = 'none';
  document.getElementById('settings-btn').classList.remove('pulse');
}

// ========== Settings Modal ==========
async function loadProviders() {
  try {
    const res = await fetch('/api/providers');
    providers = await res.json();
    const select = document.getElementById('cfg-provider');
    select.innerHTML = '<option value="">-- 请选择 --</option>' +
      providers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  } catch { /* ignore */ }
}

async function loadCurrentConfig() {
  try {
    const res = await fetch('/api/config');
    currentConfig = await res.json();
  } catch { /* ignore */ }
}

function showSettingsModal() {
  populateSettingsForm();
  document.getElementById('settings-modal-overlay').classList.add('show');
  document.getElementById('test-result').textContent = '';
}

function hideSettingsModal() {
  document.getElementById('settings-modal-overlay').classList.remove('show');
}

function populateSettingsForm() {
  const cfg = currentConfig;
  document.getElementById('cfg-provider').value = cfg.provider || '';
  document.getElementById('cfg-base-url').value = cfg.baseUrl || '';
  document.getElementById('cfg-api-key').value = '';
  document.getElementById('cfg-api-key').placeholder = cfg.hasKey ? '已配置（留空保持不变）' : 'sk-...';

  customModels = (cfg.customModels || []).map(m =>
    typeof m === 'string' ? { id: m, name: m } : m
  );

  onProviderChange(cfg.provider || '', cfg.model);
  renderCustomModelTags();
}

function onProviderChange(providerId, preserveModel) {
  const provider = providers.find(p => p.id === providerId);
  const baseUrlInput = document.getElementById('cfg-base-url');
  const modelSelect = document.getElementById('cfg-model');

  if (provider) {
    if (provider.baseUrl) {
      baseUrlInput.value = provider.baseUrl;
    }
    if (providerId === 'custom') {
      baseUrlInput.value = currentConfig.baseUrl || '';
    }
  }

  const models = provider?.models || [];
  const allModels = [...models, ...customModels];

  if (allModels.length > 0) {
    modelSelect.innerHTML = allModels.map(m =>
      `<option value="${m.id}">${m.name}</option>`
    ).join('');
  } else {
    modelSelect.innerHTML = '<option value="">请添加自定义模型</option>';
  }

  const targetModel = preserveModel || currentConfig.model;
  if (targetModel && allModels.some(m => m.id === targetModel)) {
    modelSelect.value = targetModel;
  }
}

function addCustomModel() {
  const input = document.getElementById('cfg-custom-model');
  const modelId = input.value.trim();
  if (!modelId) return;
  if (customModels.some(m => m.id === modelId)) return;

  customModels.push({ id: modelId, name: modelId });
  input.value = '';
  renderCustomModelTags();

  const providerId = document.getElementById('cfg-provider').value;
  onProviderChange(providerId, modelId);
}

function removeCustomModel(modelId) {
  customModels = customModels.filter(m => m.id !== modelId);
  renderCustomModelTags();
  const providerId = document.getElementById('cfg-provider').value;
  onProviderChange(providerId);
}

function renderCustomModelTags() {
  const container = document.getElementById('custom-model-tags');
  container.innerHTML = customModels.map(m =>
    `<span class="model-tag">${escapeHtml(m.id)} <button onclick="removeCustomModel('${escapeHtml(m.id)}')">&times;</button></span>`
  ).join('');
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('cfg-api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function testApiConfig() {
  const btn = document.getElementById('test-api-btn');
  const result = document.getElementById('test-result');
  btn.disabled = true;
  result.textContent = '测试中...';
  result.className = 'test-result';

  try {
    await saveSettingsQuiet();

    const res = await fetch('/api/config/test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      result.textContent = `✅ 连接成功！模型: ${data.model}，回复: "${data.reply}"`;
      result.className = 'test-result success';
    } else {
      result.textContent = `❌ ${data.error}`;
      result.className = 'test-result error';
    }
  } catch (err) {
    result.textContent = `❌ 请求失败: ${err.message}`;
    result.className = 'test-result error';
  } finally {
    btn.disabled = false;
  }
}

async function saveSettingsQuiet() {
  const provider = document.getElementById('cfg-provider').value;
  const baseUrl = document.getElementById('cfg-base-url').value.trim();
  const apiKey = document.getElementById('cfg-api-key').value.trim();
  const model = document.getElementById('cfg-model').value;

  const body = { provider, baseUrl, model, customModels };
  if (apiKey) body.apiKey = apiKey;

  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.config) currentConfig = data.config;
  return data;
}

async function saveSettings() {
  try {
    const data = await saveSettingsQuiet();
    if (data.ok) {
      hideSettingsModal();
      loadModel();
      if (currentConfig.hasKey) {
        hideConfigBanner();
      }
    }
  } catch (err) {
    alert('保存失败: ' + err.message);
  }
}

// ========== API ==========
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok && data.error) {
    alert(data.error);
    throw new Error(data.error);
  }
  return data;
}

async function createTask() {
  const name = document.getElementById('f-name').value.trim();
  const queriesRaw = document.getElementById('f-queries').value.trim();
  const priceMin = document.getElementById('f-price-min').value;
  const priceMax = document.getElementById('f-price-max').value;
  const maxPages = document.getElementById('f-pages').value;
  const region = document.getElementById('f-region').value.trim();
  const personalSeller = document.getElementById('f-personal').checked;
  const customRequirements = document.getElementById('f-requirements').value.trim();
  const chatStrategy = document.getElementById('f-chat-strategy').value.trim();
  const persona = document.getElementById('f-persona').value.trim();
  const coarsePrompt = document.getElementById('f-coarse-prompt').value.trim();
  const finePrompt = document.getElementById('f-fine-prompt').value.trim();

  if (!queriesRaw) {
    alert('请输入至少一个搜索关键词');
    return;
  }

  const queries = queriesRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean);

  try {
    const task = await apiPost('/api/tasks', {
      name: name || queries[0],
      queries,
      priceMin: priceMin ? Number(priceMin) : null,
      priceMax: priceMax ? Number(priceMax) : null,
      maxPages: maxPages ? Number(maxPages) : 3,
      region,
      personalSeller,
      customRequirements,
      chatStrategy,
      persona: persona || '',
      coarsePrompt: coarsePrompt || '',
      finePrompt: finePrompt || '',
    });

    hideCreateModal();
    clearForm();
  } catch { /* alert already shown */ }
}

let pendingStartTaskId = null;

function startTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  pendingStartTaskId = id;
  document.getElementById('start-modal-task-name').textContent = `任务: ${task.name}`;
  document.getElementById('s-chat-strategy').value = task.config?.chatStrategy || '';
  document.getElementById('s-persona').value = task.config?.persona || defaultPersona;
  document.getElementById('start-modal-overlay').classList.add('show');
}

function hideStartModal() {
  document.getElementById('start-modal-overlay').classList.remove('show');
  pendingStartTaskId = null;
}

async function confirmStartTask() {
  if (!pendingStartTaskId) return;

  const chatStrategy = document.getElementById('s-chat-strategy').value.trim();
  const persona = document.getElementById('s-persona').value.trim();

  try {
    await apiPost(`/api/tasks/${pendingStartTaskId}/start`, { chatStrategy, persona });
    hideStartModal();
  } catch { /* alert already shown */ }
}

async function stopTask(id) {
  await apiPost(`/api/tasks/${id}/stop`);
}

function duplicateTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task?.config) return;

  const c = task.config;
  document.getElementById('f-name').value = task.name ? `${task.name} (副本)` : '';
  document.getElementById('f-queries').value = (c.queries || []).join(', ');
  document.getElementById('f-price-min').value = c.priceMin ?? '';
  document.getElementById('f-price-max').value = c.priceMax ?? '';
  document.getElementById('f-pages').value = c.maxPages || 3;
  document.getElementById('f-region').value = c.region || '';
  document.getElementById('f-personal').checked = !!c.personalSeller;
  document.getElementById('f-requirements').value = c.customRequirements || '';
  document.getElementById('f-chat-strategy').value = c.chatStrategy || '';
  document.getElementById('f-persona').value = c.persona || defaultPersona;
  document.getElementById('f-coarse-prompt').value = c.coarsePrompt || defaultCoarsePrompt;
  document.getElementById('f-fine-prompt').value = c.finePrompt || defaultFinePrompt;

  showCreateModal();
}

async function deleteTask(id) {
  if (!confirm('确认删除此任务？')) return;
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  tasks = tasks.filter(t => t.id !== id);
  if (activeTaskId === id) {
    activeTaskId = null;
    renderTaskDetail();
  }
  renderTaskList();
}

async function refreshTask(id) {
  const res = await fetch(`/api/tasks/${id}`);
  const task = await res.json();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx >= 0) tasks[idx] = task;
  if (activeTaskId === id) renderTaskDetail();
}

// ========== Render: Task List ==========
function renderTaskList() {
  const container = document.getElementById('task-list');
  container.innerHTML = tasks.map(t => `
    <div class="task-card ${t.id === activeTaskId ? 'active' : ''}" onclick="selectTask('${t.id}')">
      <div class="task-card-name">${escapeHtml(t.name)}</div>
      <div class="task-card-meta">
        <span class="stage-badge stage-${t.stage}">${STAGE_LABELS[t.stage] || t.stage}</span>
        <span style="font-size:11px;color:var(--text2)">
          ${t.products ? `${t.products.rawCount || 0}件` : ''}
        </span>
      </div>
    </div>
  `).join('');
}

function selectTask(id) {
  activeTaskId = id;
  renderTaskList();
  refreshTask(id).then(() => renderTaskDetail());
}

// ========== Render: Task Detail ==========
function renderTaskDetail() {
  const task = tasks.find(t => t.id === activeTaskId);
  const detail = document.getElementById('task-detail');
  const empty = document.getElementById('empty-state');

  if (!task) {
    detail.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  detail.style.display = 'flex';
  empty.style.display = 'none';

  renderPipeline();
  renderProductStats();
  renderProducts();
  renderChats();
  renderLogs();
}

function renderPipeline() {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task) return;

  const currentIdx = STAGES_ORDER.indexOf(task.stage);
  const container = document.getElementById('pipeline');

  let html = STAGES_ORDER.map((stage, i) => {
    let cls = '';
    if (task.stage === 'completed') {
      cls = 'done';
    } else if (task.stage === 'stopped' || task.stage === 'stopping') {
      cls = i <= currentIdx ? 'done' : '';
    } else if (i < currentIdx) {
      cls = 'done';
    } else if (i === currentIdx) {
      cls = 'active';
    }
    return `
      ${i > 0 ? '<span class="pipeline-arrow">→</span>' : ''}
      <div class="pipeline-step ${cls}">${STAGE_LABELS[stage]}</div>
    `;
  }).join('');

  html += `
    <div class="pipeline-controls">
      <button class="btn btn-sm" onclick="duplicateTask('${task.id}')" title="复制任务配置">复制</button>
      ${task.running
        ? `<button class="btn btn-danger btn-sm" onclick="stopTask('${task.id}')">停止任务</button>`
        : `<button class="btn btn-sm" style="color:var(--green)" onclick="startTask('${task.id}')">启动</button>
           <button class="btn btn-sm" onclick="deleteTask('${task.id}')">删除</button>`
      }
    </div>
  `;

  container.innerHTML = html;
}

function renderProductStats() {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task?.products) return;

  document.getElementById('product-stats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${task.products.rawCount || 0}</div><div class="stat-label">采集总量</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--orange)">${task.products.coarseCount || 0}</div><div class="stat-label">粗筛通过</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">${task.products.fineCount || 0}</div><div class="stat-label">细筛通过</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${task.chatSessions?.length || 0}</div><div class="stat-label">聊天会话</div></div>
  `;
}

function renderProducts() {
  const task = tasks.find(t => t.id === activeTaskId);
  if (!task?.products) return;

  const fineIds = new Set((task.products.fineFiltered || []).map(p => p.id));
  const coarseIds = new Set((task.products.coarseFiltered || []).map(p => p.id));
  const chatIds = new Set((task.chatSessions || []).map(s => s.id));

  const all = task.products.raw || [];
  const tbody = document.getElementById('product-tbody');
  tbody.innerHTML = all.map(p => {
    let badge, badgeCls;
    if (chatIds.has(p.id)) { badge = '聊天中'; badgeCls = 'badge-chat'; }
    else if (fineIds.has(p.id)) { badge = '细筛✓'; badgeCls = 'badge-fine'; }
    else if (coarseIds.has(p.id)) { badge = '粗筛✓'; badgeCls = 'badge-coarse'; }
    else { badge = '采集'; badgeCls = 'badge-raw'; }

    return `<tr>
      <td>${p.image ? `<img class="product-img" src="${p.image}" loading="lazy">` : '-'}</td>
      <td class="product-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title?.slice(0, 60) || '')}</td>
      <td class="product-price">${escapeHtml(p.price || '')}</td>
      <td>${escapeHtml(p.sellerLocation || '')}</td>
      <td><span class="badge ${badgeCls}">${badge}</span></td>
    </tr>`;
  }).join('');
}

function renderChats() {
  const task = tasks.find(t => t.id === activeTaskId);
  const container = document.getElementById('chat-sessions');
  const sessions = task?.chatSessions || [];

  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:40px"><p style="color:var(--text2)">暂无聊天会话</p></div>';
    return;
  }

  container.innerHTML = sessions.map(s => {
    const ps = s.promptSummary || {};
    const statusMap = { initiating: '发起中', waiting: '监控中', error: '异常', goal_reached: '目标达成' };
    const statusLabel = statusMap[s.status] || s.status;
    const statusCls = s.status === 'goal_reached' ? 'goal' : s.status === 'waiting' ? 'chatting' : s.status === 'error' ? 'stopped' : 'pending';
    return `
    <div class="chat-session ${s.status === 'goal_reached' ? 'chat-goal-reached' : ''}">
      <div class="chat-header">
        <div>
          <span class="chat-product-name">${escapeHtml(s.productTitle?.slice(0, 40) || '')}</span>
          <span class="chat-product-price">${escapeHtml(s.productPrice || '')}</span>
          ${s.sellerName ? `<span class="chat-seller">@${escapeHtml(s.sellerName)}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="prompt-tag ${ps.hasStrategy ? 'on' : ''}">策略</span>
          <span class="prompt-tag ${ps.hasProductContext ? 'on' : ''}">商品</span>
          <span class="prompt-tag ${ps.hasRequirements ? 'on' : ''}">需求</span>
          <span class="chat-msg-count">${s.messageCount || 0}条</span>
          <span class="stage-badge stage-${statusCls}">${statusLabel}</span>
        </div>
      </div>
      ${s.status === 'goal_reached' && s.goalReason ? `
      <div class="chat-goal-banner">🎯 ${escapeHtml(s.goalReason)}</div>` : ''}
      ${s.productDescription ? `
      <div class="chat-context">
        <div class="chat-context-label">卖家商品描述</div>
        <div class="chat-context-text">${escapeHtml(s.productDescription)}</div>
      </div>` : ''}
      <div class="chat-messages">
        ${(s.messages || []).map(m => {
          const timeStr = m.time ? new Date(m.time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
          return `
          <div class="chat-msg ${m.role === 'self' ? 'self' : 'other'}">
            <div class="chat-bubble">${escapeHtml(m.content)}</div>
            ${timeStr ? `<div class="chat-msg-time">${timeStr}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  const chatBoxes = container.querySelectorAll('.chat-messages');
  chatBoxes.forEach(box => { box.scrollTop = box.scrollHeight; });
}

function renderLogs() {
  const task = tasks.find(t => t.id === activeTaskId);
  const panel = document.getElementById('log-panel');
  const logs = task?.logs || [];

  panel.innerHTML = logs.map(l =>
    `<div class="log-entry"><span class="log-time">${l.time}</span>${escapeHtml(l.message)}</div>`
  ).join('');
  panel.scrollTop = panel.scrollHeight;
}

// ========== Tab Switching ==========
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
}

// ========== Modal ==========
function showCreateModal() {
  document.getElementById('modal-overlay').classList.add('show');
}

function hideCreateModal() {
  document.getElementById('modal-overlay').classList.remove('show');
}

function clearForm() {
  ['f-name', 'f-queries', 'f-price-min', 'f-price-max', 'f-region', 'f-requirements', 'f-chat-strategy'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-pages').value = '3';
  document.getElementById('f-personal').checked = false;
  document.getElementById('f-persona').value = defaultPersona;
  document.getElementById('f-coarse-prompt').value = defaultCoarsePrompt;
  document.getElementById('f-fine-prompt').value = defaultFinePrompt;
}

function resetPersona() {
  document.getElementById('f-persona').value = defaultPersona;
}

function resetCoarsePrompt() {
  document.getElementById('f-coarse-prompt').value = defaultCoarsePrompt;
}

function resetFinePrompt() {
  document.getElementById('f-fine-prompt').value = defaultFinePrompt;
}

async function loadDefaults() {
  try {
    const res = await fetch('/api/defaults');
    const data = await res.json();
    defaultPersona = data.persona || '';
    defaultCoarsePrompt = data.coarsePrompt || '';
    defaultFinePrompt = data.finePrompt || '';
    document.getElementById('f-persona').value = defaultPersona;
    document.getElementById('f-coarse-prompt').value = defaultCoarsePrompt;
    document.getElementById('f-fine-prompt').value = defaultFinePrompt;
  } catch { /* ignore */ }
}

// ========== Utils ==========
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========== Model Switching ==========
async function loadModel() {
  try {
    const res = await fetch('/api/model');
    const data = await res.json();
    const select = document.getElementById('model-select');
    if (data.models && data.models.length > 0) {
      select.innerHTML = data.models.map(m =>
        `<option value="${m.id}" ${m.id === data.current ? 'selected' : ''}>${m.name}</option>`
      ).join('');
    } else {
      select.innerHTML = '<option value="">未配置</option>';
    }
  } catch { /* ignore */ }
}

async function switchModel(modelId) {
  try {
    await apiPost('/api/model', { modelId });
  } catch { /* ignore */ }
}

// ========== Init ==========
connectWS();
loadDefaults();
loadProviders().then(() => loadCurrentConfig());
loadModel();
