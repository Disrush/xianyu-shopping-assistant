import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '..', 'browser-data');

let _context = null;
let _launching = null;

export async function getBrowserContext() {
  if (_context) return _context;
  if (_launching) return _launching;

  _launching = chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1366, height: 900 },
    locale: 'zh-CN',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
    ],
  });

  _context = await _launching;
  _launching = null;

  _context.on('close', () => { _context = null; });
  return _context;
}

export async function newPage() {
  const ctx = await getBrowserContext();
  return ctx.newPage();
}

export async function closeBrowser() {
  if (_context) {
    await _context.close().catch(() => {});
    _context = null;
  }
}
