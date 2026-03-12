import { getBrowserContext } from './browser.mjs';
import { sleep } from './utils.mjs';

const HOME_URL = 'https://www.goofish.com/';

export async function checkLogin(emitLog) {
  const ctx = await getBrowserContext();
  const page = ctx.pages()[0] || await ctx.newPage();

  emitLog('正在打开闲鱼首页...');
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  for (let attempt = 0; attempt < 5; attempt++) {
    const loggedIn = await detectLoginState(page);
    if (loggedIn) {
      emitLog('✅ 登录状态正常');
      return true;
    }

    const remaining = 5 - attempt - 1;
    emitLog(`⚠️ 未检测到登录状态，请在浏览器中手动登录（剩余${remaining}次重试机会）`);
    emitLog('等待20秒后重新检测...');
    await sleep(20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(3000);
  }

  emitLog('❌ 多次检测均未登录，请登录后重新启动任务');
  return false;
}

async function detectLoginState(page) {
  try {
    const nickEl = page.locator('[class*="nick--"]').first();
    const visible = await nickEl.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) return true;

    const avatarEl = page.locator('[class*="user-order-container"] img').first();
    const avatarVisible = await avatarEl.isVisible({ timeout: 2000 }).catch(() => false);
    if (avatarVisible) return true;

    const loginBtn = page.locator('text=登录').first();
    const loginVisible = await loginBtn.isVisible({ timeout: 1000 }).catch(() => false);
    if (loginVisible) return false;

    return false;
  } catch {
    return false;
  }
}
