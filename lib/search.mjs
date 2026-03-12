import { newPage } from './browser.mjs';
import { randomDelay, sleep, waitIfVerification } from './utils.mjs';

const BASE_SEARCH_URL = 'https://www.goofish.com/search';

export async function searchProducts(query, filters, maxPages, emitLog, shouldStop) {
  const page = await newPage();
  const allProducts = [];

  try {
    const url = new URL(BASE_SEARCH_URL);
    url.searchParams.set('q', query);
    emitLog(`🔍 搜索: "${query}" (最多${maxPages}页)`);

    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    const verifyOk = await waitIfVerification(page, { emitLog, shouldStop, label: query });
    if (!verifyOk) {
      emitLog(`⚠️ 搜索 "${query}" 校验未通过，跳过`);
      return allProducts;
    }

    await applyFilters(page, filters, emitLog);
    await sleep(2000);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (shouldStop()) break;

      const pageVerify = await waitIfVerification(page, { emitLog, shouldStop, label: `${query} P${pageNum}` });
      if (!pageVerify) break;

      emitLog(`📄 正在采集第 ${pageNum} 页...`);
      const products = await scrapeCurrentPage(page);
      emitLog(`  找到 ${products.length} 个商品`);
      allProducts.push(...products);

      if (pageNum < maxPages) {
        const hasNext = await goNextPage(page);
        if (!hasNext) {
          emitLog('  已到最后一页');
          break;
        }
        await randomDelay(3000, 6000);
      }
    }
  } catch (err) {
    emitLog(`❌ 搜索出错: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  emitLog(`🔍 "${query}" 搜索完成，共采集 ${allProducts.length} 个商品`);
  return allProducts;
}

async function applyFilters(page, filters, emitLog) {
  try {
    // ---- 个人闲置勾选 ----
    if (filters.personalSeller) {
      const checkbox = page.locator('[class*="search-checkbox-item-container"]:has-text("个人闲置")');
      const visible = await checkbox.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) {
        await checkbox.click();
        emitLog('  已勾选: 个人闲置');
        await sleep(1500);
      } else {
        emitLog('  ⚠️ 未找到"个人闲置"复选框');
      }
    }

    // ---- 价格区间 ----
    if (filters.priceMin != null || filters.priceMax != null) {
      const priceInputs = page.locator('input[class*="search-price-input"]');
      const count = await priceInputs.count();
      if (count >= 2) {
        if (filters.priceMin != null) {
          await priceInputs.nth(0).click();
          await priceInputs.nth(0).fill('');
          await priceInputs.nth(0).pressSequentially(String(filters.priceMin), { delay: 80 });
          await sleep(300);
        }
        if (filters.priceMax != null) {
          await priceInputs.nth(1).click();
          await priceInputs.nth(1).fill('');
          await priceInputs.nth(1).pressSequentially(String(filters.priceMax), { delay: 80 });
          await sleep(300);
        }
        await sleep(500);
        const confirmBtn = page.locator('button[class*="search-price-confirm"]');
        try {
          await confirmBtn.click({ timeout: 5000 });
          emitLog(`  已设置价格区间: ${filters.priceMin ?? '不限'} - ${filters.priceMax ?? '不限'}`);
          await sleep(2000);
        } catch {
          try {
            const lastInput = priceInputs.nth(filters.priceMax != null ? 1 : 0);
            await lastInput.press('Enter');
            emitLog(`  已设置价格区间(回车提交): ${filters.priceMin ?? '不限'} - ${filters.priceMax ?? '不限'}`);
            await sleep(2000);
          } catch {
            emitLog('  ⚠️ 价格筛选提交失败，按钮和回车均无效');
          }
        }
      } else {
        emitLog(`  ⚠️ 价格输入框未找到(found ${count})，价格筛选未生效`);
      }
    }

    // ---- 地域筛选（通过页面区域面板） ----
    if (filters.region) {
      await applyRegionFilter(page, filters.region, emitLog);
    }
  } catch (err) {
    emitLog(`  筛选器应用失败: ${err.message}`);
  }
}

/**
 * 通过闲鱼搜索页的"区域"面板设置地域筛选。
 * 支持输入：省份名（四川）、城市名（成都）、或"省份 城市"组合。
 * 面板结构：点击"区域"按钮 → 左列省份 → 右列城市 → 确认
 */
async function applyRegionFilter(page, regionInput, emitLog) {
  const input = regionInput.trim().replace(/[,，、\s]+/g, ' ');
  const parts = input.split(' ').filter(Boolean);

  // 所有省份名
  const PROVINCES = [
    '北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江',
    '上海','江苏','浙江','安徽','福建','江西','山东','河南',
    '湖北','湖南','广东','广西','海南','重庆','四川','贵州',
    '云南','西藏','陕西','甘肃','青海','宁夏','新疆','台湾',
    '香港','澳门','海外',
  ];

  // 区域组
  const REGION_GROUPS = ['珠三角','江浙沪','京津冀','东三省'];

  // 主要城市→省份映射（覆盖常见大城市）
  const CITY_PROVINCE_MAP = {
    '成都':'四川','绵阳':'四川','德阳':'四川','宜宾':'四川','南充':'四川','泸州':'四川','达州':'四川','乐山':'四川','眉山':'四川',
    '广州':'广东','深圳':'广东','东莞':'广东','佛山':'广东','珠海':'广东','惠州':'广东','中山':'广东',
    '杭州':'浙江','宁波':'浙江','温州':'浙江','嘉兴':'浙江','绍兴':'浙江','金华':'浙江',
    '南京':'江苏','苏州':'江苏','无锡':'江苏','常州':'江苏','南通':'江苏','徐州':'江苏',
    '武汉':'湖北','宜昌':'湖北','襄阳':'湖北',
    '长沙':'湖南','株洲':'湖南','湘潭':'湖南','衡阳':'湖南',
    '济南':'山东','青岛':'山东','烟台':'山东','潍坊':'山东','临沂':'山东',
    '郑州':'河南','洛阳':'河南','开封':'河南','南阳':'河南',
    '石家庄':'河北','唐山':'河北','保定':'河北','邯郸':'河北',
    '太原':'山西','大同':'山西',
    '西安':'陕西','咸阳':'陕西','宝鸡':'陕西',
    '合肥':'安徽','芜湖':'安徽','蚌埠':'安徽',
    '福州':'福建','厦门':'福建','泉州':'福建',
    '南昌':'江西','赣州':'江西','九江':'江西',
    '昆明':'云南','大理':'云南','丽江':'云南',
    '贵阳':'贵州','遵义':'贵州',
    '兰州':'甘肃','天水':'甘肃',
    '沈阳':'辽宁','大连':'辽宁','鞍山':'辽宁',
    '长春':'吉林','吉林市':'吉林',
    '哈尔滨':'黑龙江','大庆':'黑龙江','齐齐哈尔':'黑龙江',
    '南宁':'广西','桂林':'广西','柳州':'广西',
    '海口':'海南','三亚':'海南',
    '呼和浩特':'内蒙古','包头':'内蒙古','鄂尔多斯':'内蒙古',
    '银川':'宁夏',
    '西宁':'青海',
    '乌鲁木齐':'新疆',
    '拉萨':'西藏',
  };

  // 解析输入：分离出省份和城市
  let province = null;
  let city = null;

  for (const part of parts) {
    if (PROVINCES.includes(part)) {
      province = part;
    } else if (REGION_GROUPS.includes(part)) {
      province = part;
    } else if (CITY_PROVINCE_MAP[part]) {
      city = part;
      if (!province) province = CITY_PROVINCE_MAP[part];
    } else {
      // 模糊匹配：看看是否是省份的一部分
      const matched = PROVINCES.find(p => p.includes(part) || part.includes(p));
      if (matched) {
        province = matched;
      } else {
        // 尝试作为城市处理，在面板中动态匹配
        city = part;
      }
    }
  }

  if (!province && !city) {
    emitLog(`  ⚠️ 无法识别地区: "${regionInput}"`);
    return;
  }

  emitLog(`  地区解析: 省份="${province || '自动'}" 城市="${city || '不限'}"`);

  // Step 1: 点击"区域"按钮打开面板
  const areaBtn = page.locator('[class*="areaText"]').first();
  const areaVisible = await areaBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (!areaVisible) {
    emitLog('  ⚠️ 未找到区域筛选按钮');
    return;
  }
  await areaBtn.click();
  await sleep(1200);

  // Step 2: 在左列找到并点击省份
  const panel = page.locator('[class*="panel--"]').first();
  const panelVisible = await panel.isVisible({ timeout: 2000 }).catch(() => false);
  if (!panelVisible) {
    emitLog('  ⚠️ 区域面板未弹出');
    return;
  }

  if (province) {
    const provItems = panel.locator('[class*="provItem"]');
    const provCount = await provItems.count();
    let clicked = false;

    for (let i = 0; i < provCount; i++) {
      const text = await provItems.nth(i).textContent().catch(() => '');
      if (text.trim() === province) {
        await provItems.nth(i).click();
        clicked = true;
        emitLog(`  已选择省份: ${province}`);
        await sleep(1000);
        break;
      }
    }

    if (!clicked) {
      emitLog(`  ⚠️ 省份列表中未找到: "${province}"`);
    }
  }

  // Step 3: 如果指定了城市，在右列找到并点击
  if (city) {
    await sleep(800);
    // 右列是面板中第二个 col
    const cols = panel.locator('[class*="col--"]');
    const colCount = await cols.count();

    if (colCount >= 2) {
      const rightCol = cols.nth(1);
      const cityItems = rightCol.locator('[class*="provItem"]');
      const cityCount = await cityItems.count();
      let cityClicked = false;

      for (let i = 0; i < cityCount; i++) {
        const text = await cityItems.nth(i).textContent().catch(() => '');
        if (text.trim() === city) {
          await cityItems.nth(i).click();
          cityClicked = true;
          emitLog(`  已选择城市: ${city}`);
          await sleep(800);
          break;
        }
      }

      if (!cityClicked && city) {
        // 如果没有找到精确匹配的城市，而且还没选省份，
        // 尝试遍历所有省份找到包含该城市的
        if (!province) {
          emitLog(`  城市 "${city}" 未找到，尝试遍历省份...`);
          const leftCol = cols.nth(0);
          const provItems = leftCol.locator('[class*="provItem"]');
          const provCount = await provItems.count();

          for (let i = 1; i < provCount; i++) { // 跳过"全国"
            await provItems.nth(i).click();
            await sleep(600);
            const updatedCityItems = rightCol.locator('[class*="provItem"]');
            const updatedCount = await updatedCityItems.count();
            for (let j = 0; j < updatedCount; j++) {
              const ct = await updatedCityItems.nth(j).textContent().catch(() => '');
              if (ct.trim() === city) {
                await updatedCityItems.nth(j).click();
                cityClicked = true;
                const provName = await provItems.nth(i).textContent().catch(() => '');
                emitLog(`  找到城市: ${provName} → ${city}`);
                break;
              }
            }
            if (cityClicked) break;
          }

          if (!cityClicked) {
            emitLog(`  ⚠️ 所有省份中未找到城市: "${city}"，将使用当前省份级筛选`);
          }
        } else {
          emitLog(`  ⚠️ ${province}下未找到城市: "${city}"，将使用省份级筛选`);
        }
      }
    }
  }

  // Step 4: 点击确认按钮
  const confirmBtn = panel.locator('[class*="searchBtn"]').first();
  const confirmVisible = await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false);
  if (confirmVisible) {
    await confirmBtn.click();
    emitLog(`  ✅ 地区筛选已应用`);
    await sleep(2000);
  } else {
    emitLog('  ⚠️ 未找到确认按钮，尝试点击面板外关闭');
    await page.mouse.click(100, 100);
    await sleep(1000);
  }
}

async function scrapeCurrentPage(page) {
  await autoScroll(page);

  return page.evaluate(() => {
    const items = [];
    const cards = document.querySelectorAll('a[class*="feeds-item-wrap"]');

    cards.forEach(card => {
      const href = card.getAttribute('href') || '';
      const idMatch = href.match(/[?&]id=(\d+)/);
      if (!idMatch) return;

      const titleEl = card.querySelector('[class*="row1-wrap-title"]');
      const priceEl = card.querySelector('[class*="price-wrap"]');
      const descEl = card.querySelector('[class*="price-desc"]');
      const sellerWrap = card.querySelector('[class*="seller-text-wrap"]');
      const imgEl = card.querySelector('img[class*="feeds-image"]');

      items.push({
        id: idMatch[1],
        href: href.startsWith('http') ? href : `https://www.goofish.com${href}`,
        title: titleEl?.getAttribute('title') || titleEl?.textContent?.trim() || '',
        price: priceEl?.textContent?.trim() || '',
        priceDesc: descEl?.textContent?.trim() || '',
        sellerLocation: sellerWrap?.getAttribute('title') || '',
        image: imgEl?.src || '',
      });
    });

    return items;
  });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let scrolled = 0;
      const maxScroll = document.body.scrollHeight;
      const step = 400 + Math.random() * 300;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        scrolled += step;
        if (scrolled >= maxScroll) {
          clearInterval(timer);
          resolve();
        }
      }, 200 + Math.random() * 300);

      setTimeout(() => { clearInterval(timer); resolve(); }, 8000);
    });
  });
  await sleep(1000);
}

async function goNextPage(page) {
  try {
    const nextBtns = page.locator('button[class*="search-pagination-arrow-container"]');
    const count = await nextBtns.count();
    if (count >= 2) {
      const nextBtn = nextBtns.nth(1);
      const disabled = await nextBtn.getAttribute('disabled');
      if (disabled !== null) return false;
      await nextBtn.click();
      await sleep(3000);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

