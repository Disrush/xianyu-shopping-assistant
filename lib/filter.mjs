import { newPage } from './browser.mjs';
import { judgeByTitle, judgeByDetail } from './ai.mjs';
import { randomDelay, extractItemId, extractUserId, sleep, waitIfVerification } from './utils.mjs';

const BATCH_SIZE = 15;

export async function coarseFilter(products, requirements, emitLog, shouldStop, customPromptHead) {
  emitLog(`🔸 粗筛开始，共 ${products.length} 个商品`);
  const passed = [];

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    if (shouldStop()) break;

    const batch = products.slice(i, i + BATCH_SIZE);
    const titles = batch.map(p => p.title);
    emitLog(`  AI判断第 ${i + 1}-${Math.min(i + BATCH_SIZE, products.length)} 个...`);

    try {
      const passedIndices = await judgeByTitle(titles, requirements, customPromptHead, emitLog);
      const validIndices = passedIndices.filter(idx => idx >= 0 && idx < batch.length);
      validIndices.forEach(idx => passed.push(batch[idx]));
      emitLog(`  本批通过 ${validIndices.length}/${batch.length}`);
    } catch (err) {
      emitLog(`  ⚠️ AI判断出错，保留本批全部: ${err.message}`);
      passed.push(...batch);
    }

    await randomDelay(1000, 2000);
  }

  emitLog(`🔸 粗筛完成: ${passed.length}/${products.length} 通过`);
  return passed;
}

export async function fineFilter(products, requirements, emitLog, shouldStop, customPromptHead) {
  emitLog(`🔹 细筛开始，共 ${products.length} 个商品`);
  const passed = [];

  for (let i = 0; i < products.length; i++) {
    if (shouldStop()) break;

    const product = products[i];
    emitLog(`  细筛 [${i + 1}/${products.length}] ${product.title.slice(0, 30)}...`);

    try {
      const detail = await fetchProductDetail(product, emitLog, shouldStop);
      const enriched = { ...product, ...detail };

      const result = await judgeByDetail(enriched, requirements, customPromptHead, emitLog);
      if (result.pass) {
        emitLog(`    ✅ 通过 - ${result.reason}`);
        passed.push(enriched);
      } else {
        emitLog(`    ❌ 不通过 - ${result.reason}`);
      }
    } catch (err) {
      emitLog(`    ⚠️ 细筛出错，跳过: ${err.message}`);
    }

    await randomDelay(5000, 12000);
  }

  emitLog(`🔹 细筛完成: ${passed.length}/${products.length} 通过`);
  return passed;
}

async function fetchProductDetail(product, emitLog, shouldStop) {
  const page = await newPage();
  try {
    await page.goto(product.href, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const verifyOk = await waitIfVerification(page, {
      emitLog,
      shouldStop,
      label: product.title?.slice(0, 15),
    });
    if (!verifyOk) {
      return { description: '', sellerName: '', sellerLocation: '', error: '校验未通过' };
    }

    await sleep(3000);

    const detail = await page.evaluate(() => {
      const descEl = document.querySelector('[class*="main--"][class*="open--"]')
        || document.querySelector('[class*="notLoginContainer"] [class*="main--"]');
      const description = descEl?.textContent?.trim().slice(0, 500) || '';

      const nickEl = document.querySelector('[class*="item-user-info-nick"]');
      const sellerName = nickEl?.textContent?.trim() || '';

      const labels = document.querySelectorAll('[class*="item-user-info-label"]');
      const labelTexts = [...labels].map(l => l.textContent?.trim());
      const sellerLocation = labelTexts[0] || '';
      const sellerRating = labelTexts.find(t => t?.includes('好评')) || '';

      const priceEl = document.querySelector('[class*="price--"][class*="windows"]')
        || document.querySelector('[class*="price--"]');
      const detailPrice = priceEl?.textContent?.trim() || '';

      const wantEl = document.querySelector('[class*="want--"]');
      const wantCount = wantEl?.textContent?.trim() || '';

      const chatLink = document.querySelector('a[href*="/im?itemId="]');
      const chatUrl = chatLink?.href || '';

      const buyLink = document.querySelector('a[href*="/create-order"]');
      const buyUrl = buyLink?.href || '';

      const images = [...document.querySelectorAll('[class*="carouselItem"] img')]
        .map(img => img.src).filter(Boolean).slice(0, 5);

      return {
        description,
        sellerName,
        sellerLocation,
        sellerRating,
        detailPrice: detailPrice,
        wantCount,
        chatUrl,
        buyUrl,
        images,
      };
    });

    const chatLink = await page.locator('a[href*="/im?itemId="]').first().getAttribute('href').catch(() => '');
    if (chatLink) {
      detail.chatUrl = chatLink.startsWith('http') ? chatLink : `https://www.goofish.com${chatLink}`;
      detail.sellerId = extractUserId(chatLink);
    }

    return detail;
  } catch (err) {
    return { description: '', sellerName: '', sellerLocation: '', error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}
