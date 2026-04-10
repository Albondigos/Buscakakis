const { chromium } = require('playwright');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;

const SEEN_FILE = './seen.json';
const CONFIG_FILE = './config.json';

// ---------------- CONFIG ----------------

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { keywords: [], minPrice: 0, onlyPallets: false };
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

// ---------------- FILTER ----------------

function normalize(t) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function matches(text, keywords) {
  const t = normalize(text);
  return keywords.some(k => t.includes(normalize(k)));
}

// ---------------- DISCORD ----------------

async function sendDiscord(payload) {
  if (!WEBHOOK_URL) return;

  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ---------------- MAIN ----------------

(async () => {
  const config = loadConfig();
  const seen = loadSeen();

  console.log("BOT ARRANCADO");
  console.log("FILTROS:", config);

  await sendDiscord({ content: "BOT ARRANCADO" });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  await page.goto(
    'https://jobalots.com/en/pages/products-on-auction?currency=gbp',
    { waitUntil: 'networkidle' }
  );

  await page.waitForTimeout(4000);

  const candidates = await page.$$eval('a[href*="/products/"]', links =>
    [...new Map(
      links.map(a => [a.href, {
        href: a.href
      }])
    ).values()]
  );

  console.log("PRODUCTOS:", candidates.length);

  for (const item of candidates) {

    if (seen.includes(item.href)) continue;

    try {
      const p = await browser.newPage();

      await p.goto(item.href, { waitUntil: 'networkidle' });
      await p.waitForTimeout(2000);

      const text = await p.evaluate(() => document.body?.innerText || '');
      const title = await p.title();
      const full = `${title} ${text}`;

      // ---------------- FILTER LOGIC ----------------
      if (config.keywords.length > 0 && !matches(full, config.keywords)) {
        await p.close();
        continue;
      }

      // ---------------- IMAGE FIX ----------------
      let image = null;
      try {
        image = await p.evaluate(() => {
          const img =
            document.querySelector('img') ||
            document.querySelector('meta[property="og:image"]');

          return img?.content || img?.src || null;
        });
      } catch {}

      const price = text.match(/£\s?[0-9]+([.,][0-9]+)?/)?.[0] || 'No detectado';

      await sendDiscord({
        embeds: [
          {
            title: `🔥 ${title}`,
            url: item.href,
            color: 16753920,
            thumbnail: image ? { url: image } : undefined,
            fields: [
              { name: 'Precio', value: price, inline: true }
            ]
          }
        ]
      });

      seen.push(item.href);
      saveSeen(seen);

      await p.close();
      await new Promise(r => setTimeout(r, 1500));

    } catch (e) {
      console.log("ERROR:", e.message);
    }
  }

  await browser.close();

  console.log("FIN");
})();
