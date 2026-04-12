const { chromium } = require('playwright');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
const SEEN_FILE   = './seen.json';
const CONFIG_FILE = './config.json';

// ---------------- CONFIG ----------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { keywords: [], minPrice: 0 };
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE));
}

// ---------------- SEEN ----------------
function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return [];
  return JSON.parse(fs.readFileSync(SEEN_FILE));
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

// ---------------- FILTROS ----------------
function normalize(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function matches(text, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const t = normalize(text);
  return keywords.some(k => t.includes(normalize(k)));
}

// ---------------- DISCORD ----------------
async function sendDiscord(payload) {
  if (!WEBHOOK_URL) {
    console.log('[Discord] Sin webhook, saltando.');
    return;
  }
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) console.log('[Discord] Error:', res.status, await res.text());
  } catch (e) {
    console.log('[Discord] Fallo:', e.message);
  }
}

// ---------------- SCROLL ----------------
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const dist = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, dist);
        total += dist;
        if (total >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
  await page.waitForTimeout(2000);
}

// ---------------- IMAGEN ----------------
async function extractImage(page) {
  try {
    return await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]');
      if (og?.content) return og.content;
      const tw = document.querySelector('meta[name="twitter:image"]');
      if (tw?.content) return tw.content;
      const imgs = [...document.querySelectorAll('img')];
      const img = imgs.find(i =>
        i.src &&
        !i.src.includes('logo') &&
        !i.src.includes('icon') &&
        (i.naturalWidth > 100 || i.width > 100 || i.naturalWidth === 0)
      );
      return img?.src || null;
    });
  } catch { return null; }
}

// ---------------- TIEMPO RESTANTE ----------------
async function extractTimeLeft(page) {
  try {
    return await page.evaluate(() => {
      const selectors = [
        '[class*="countdown"]', '[class*="timer"]', '[class*="time-left"]',
        '[class*="time_left"]', '[data-countdown]', '[class*="auction-time"]',
        '[class*="ends-in"]', '[class*="remaining"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.innerText?.trim()) return el.innerText.trim();
      }
      for (const el of [...document.querySelectorAll('*')]) {
        if (el.children.length > 0) continue;
        const t = (el.innerText || '').toLowerCase();
        if (
          (t.includes('ends') || t.includes('closes') || t.includes('left') || t.includes('remaining')) &&
          /\d/.test(t) &&
          t.length < 60
        ) {
          return el.innerText.trim();
        }
      }
      return null;
    });
  } catch { return null; }
}

// ---------------- PRECIO ----------------
function extractPrice(text) {
  const match = text.match(/[£€]\s?[0-9]+([.,][0-9]+)?/);
  return match ? match[0] : null;
}

// ---------------- LINKS ----------------
async function collectProductLinks(page) {
  await autoScroll(page);
  const links = await page.$$eval('a', anchors =>
    anchors.map(a => a.href).filter(href =>
      href &&
      href.includes('jobalots.com') &&
      (href.includes('/products/') || href.includes('/lots/') || href.includes('/auction/'))
    )
  );
  return [...new Set(links)];
}

// ---------------- MAIN ----------------
(async () => {
  const config = loadConfig();
  const seen   = loadSeen();

  console.log('=== BOT JOBALOTS ===');
  console.log('Filtros:', config.keywords.length > 0 ? config.keywords.join(', ') : 'ninguno');
  console.log('Productos ya vistos:', seen.length);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  try {
    await page.goto(
      'https://jobalots.com/en/pages/products-on-auction?currency=gbp',
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    await page.waitForTimeout(3000);

    const productLinks = await collectProductLinks(page);
    const newLinks = productLinks.filter(href => !seen.includes(href));

    console.log(`Total: ${productLinks.length} | Nuevos: ${newLinks.length}`);

    for (const href of newLinks) {
      try {
        const p = await browser.newPage();
        await p.goto(href, { waitUntil: 'networkidle', timeout: 30000 });
        await p.waitForTimeout(2000);

        const text  = await p.evaluate(() => document.body?.innerText || '');
        const title = await p.title();

        // Filtro de palabras clave
        if (!matches(`${title} ${text}`, config.keywords)) {
          await p.close();
          seen.push(href);
          saveSeen(seen);
          continue;
        }

        // Filtro de precio mínimo
        const priceRaw = extractPrice(text);
        if (config.minPrice > 0 && priceRaw) {
          const num = parseFloat(priceRaw.replace(/[£€,]/, '').trim());
          if (!isNaN(num) && num < config.minPrice) {
            await p.close();
            seen.push(href);
            saveSeen(seen);
            continue;
          }
        }

        const image    = await extractImage(p);
        const price    = priceRaw || 'No detectado';
        const timeLeft = await extractTimeLeft(p);

        console.log(`[NUEVO] ${title} | ${price} | ${timeLeft || 'sin tiempo'}`);

        const fields = [{ name: '💰 Precio', value: price, inline: true }];
        if (timeLeft) fields.push({ name: '⏳ Tiempo restante', value: timeLeft, inline: true });

        await sendDiscord({
          embeds: [{
            title: `🔥 ${title.slice(0, 256)}`,
            url: href,
            color: 16753920,
            image: image ? { url: image } : undefined,
            fields,
            footer: { text: 'Jobalots Bot' },
            timestamp: new Date().toISOString()
          }]
        });

        seen.push(href);
        saveSeen(seen);
        await p.close();
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.log(`[ERROR producto] ${e.message}`);
      }
    }
  } catch (e) {
    console.log('[ERROR general]', e.message);
  } finally {
    await page.close().catch(() => {});
    await browser.close();
  }

  console.log('=== FIN ===');
})();
