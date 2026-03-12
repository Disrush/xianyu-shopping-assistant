export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

export function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

export function genId() {
  return crypto.randomUUID().slice(0, 8);
}

export function parsePrice(text) {
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

export function extractItemId(url) {
  const match = url.match(/[?&]id=(\d+)/);
  return match ? match[1] : null;
}

export function extractUserId(url) {
  const match = url.match(/[?&](?:userId|peerUserId)=(\d+)/);
  return match ? match[1] : null;
}

export function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * 通用真人校验检测：检查当前页面是否触发了平台验证。
 * 如果检测到验证页面，会持续轮询等待用户手动完成（最长 maxWaitMs）。
 * @returns {Promise<boolean>} true=校验通过或无校验，false=超时或任务停止
 */
export async function waitIfVerification(page, { emitLog, shouldStop, label = '', maxWaitMs = 300000 } = {}) {
  const prefix = label ? `[${label}] ` : '';
  const checkInterval = 5000;
  let waited = 0;

  while (waited < maxWaitMs) {
    const hasVerify = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const url = location.href;
      if (url.includes('verify') || url.includes('captcha') || url.includes('checkcode')) return true;
      if (bodyText.includes('安全验证') || bodyText.includes('滑动验证')
        || bodyText.includes('请完成验证') || bodyText.includes('人机验证')
        || bodyText.includes('拖动滑块') || bodyText.includes('点击完成验证')) return true;
      const iframe = document.querySelector('iframe[src*="captcha"], iframe[src*="verify"]');
      if (iframe) return true;
      return false;
    }).catch(() => false);

    if (!hasVerify) return true;

    if (waited === 0) {
      if (emitLog) emitLog(`  ${prefix}🛑 检测到平台真人校验！请在浏览器中手动完成验证，完成后自动继续...`);
    }

    await sleep(checkInterval);
    waited += checkInterval;

    if (shouldStop && shouldStop()) {
      if (emitLog) emitLog(`  ${prefix}任务已停止，中断校验等待`);
      return false;
    }
  }

  if (emitLog) emitLog(`  ${prefix}⚠️ 等待校验超时（${Math.round(maxWaitMs / 60000)}分钟），跳过本次`);
  return false;
}
