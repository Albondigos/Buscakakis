const { chromium } = require('playwright');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;

const KEYWORDS = [
  '3d',
  'printer',
  'resin',
  'resina',
  'gaming',
  'game',
  'volante',
  'logitech',
  'thrustmaster'
];

const SEEN_FILE = './seen.json';

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE));
  } catch {
    return [];
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function matchesKeyword(text) {
  const t = normalize(text);
  return KEYWORDS.some(k => t.includes(normalize(k)));
}

function extractMoney(text) {
  const match = text.match(/€\s?[0-9]+([.,][0-9]+)?/);
  return match ? match[0] : 'No detectado';
}

function extractEndTime(text) {
  const match = text.match(/(\d+\s?(d|h|min))/gi);
  return match ? match.join(' ') : 'No detectado';
}

async function sendDiscord(payload) {
  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

(async () => {
  const seen = loadSeen();

  console.log("BOT ARRANCADO");

  await sendDiscord({
    content: "BOT ARRANCADO"
  });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  await page.goto(
    'https://jobalots.com/en/pages/products-on-auction?currency=gbp',
    { waitUntil: 'domcontentloaded' }
  );

  // 🔥 FIX: espera real de productos
  await page.waitForSelector('a[href*="/products/"]', { timeout: 20000 });

  const candidates = await page.$$eval('a[href*="/products/"]', links =>
    [...new Map(
      links.map(a => [a.href, {
        text: (a.innerText || '').trim(),
        href: a.href
      }])
    ).values()]
  );

  console.log("PRODUCTOS:", candidates.length);

  console.log("SAMPLE CANDIDATES:", candidates.slice(0, 5));

  for (const item of candidates) {

    if (seen.includes(item.href)) continue;

    try {
      await page.goto(item.href, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      const text = await page.evaluate(() => document.body.innerText || '');
      const title = await page.title();

      const full = `${title} ${text}`;

      console.log("TITLE:", title);
      console.log("MATCH:", matchesKeyword(full));

      if (!matchesKeyword(full)) continue;

      let image = null;
      try {
        image = await page.$eval('img', img => img.src);
      } catch {}

      const price = extractMoney(text);
      const endTime = extractEndTime(text);

      await sendDiscord({
        embeds: [
          {
            title: `🔥 ${title}`,
            url: item.href,
            color: 16753920,
            thumbnail: image ? { url: image } : undefined,
            fields: [
              { name: 'Precio', value: price, inline: true },
              { name: 'Tiempo', value: endTime, inline: false }
            ]
          }
        ]
      });

      seen.push(item.href);
      saveSeen(seen);

      await new Promise(r => setTimeout(r, 2000));

    } catch (e) {
      console.log("ERROR:", e.message);
    }
  }

  await browser.close();

  console.log("FIN");
})();
