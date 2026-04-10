const { chromium } = require('playwright');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;

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

function extractMoney(text) {
  const match = text.match(/€\s?[0-9]+([.,][0-9]+)?|£\s?[0-9]+([.,][0-9]+)?/);
  return match ? match[0] : 'No detectado';
}

function extractEndTime(text) {
  const match = text.match(/(\d+\s?(d|h|min))/gi);
  return match ? match.join(' ') : 'No detectado';
}

async function sendDiscord(payload) {
  if (!WEBHOOK_URL) return;

  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

(async () => {
  const seen = loadSeen();

  console.log("BOT ARRANCADO");

  await sendDiscord({ content: "BOT ARRANCADO" });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // 🔥 cargar página mejor
  await page.goto(
    'https://jobalots.com/en/pages/products-on-auction?currency=gbp',
    { waitUntil: 'networkidle' }
  );

  // 🔥 scroll para cargar contenido dinámico oculto
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1500);
  }

  await page.waitForSelector('a[href*="/products/"]', { timeout: 20000 });

  // 🔥 extraer enlaces únicos visibles tras scroll
  const candidates = await page.$$eval('a[href*="/products/"]', links =>
    [...new Map(
      links.map(a => [a.href, {
        href: a.href,
        text: (a.innerText || '').trim()
      }])
    ).values()]
  );

  console.log("PRODUCTOS DETECTADOS:", candidates.length);

  for (const item of candidates) {

    if (seen.includes(item.href)) continue;

    try {
      const p = await browser.newPage();

      await p.goto(item.href, { waitUntil: 'networkidle' });
      await p.waitForTimeout(2000);

      const text = await p.evaluate(() =>
        document.body ? document.body.innerText : ''
      );

      const title = await p.title();
      const full = `${title} ${text}`;

      console.log("PROCESANDO:", title);

      let image = null;
      try {
        image = await p.$eval('img', img => img.src);
      } catch {}

      const price = extractMoney(text);
      const time = extractEndTime(text);

      await sendDiscord({
        embeds: [
          {
            title: `🔥 ${title}`,
            url: item.href,
            color: 16753920,
            thumbnail: image ? { url: image } : undefined,
            fields: [
              { name: 'Precio', value: price, inline: true },
              { name: 'Tiempo', value: time, inline: false }
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
