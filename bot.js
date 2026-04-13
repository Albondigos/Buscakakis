const { chromium } = require('playwright');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
const GIST_ID     = process.env.GIST_ID;
const GIST_TOKEN  = process.env.GIST_TOKEN;
const CONFIG_FILE = './config.json';
const MAX_NEW_PER_RUN = 30;

// ---------------- CONFIG ----------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { keywords: [], minPrice: 0 };
  return JSON.parse(fs.readFileSync(CONFIG_FILE));
}

// ---------------- SEEN (Gist) ----------------
async function loadSeen() {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `token ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    const data = await res.json();
    const content = data.files['seen.json']?.content || '[]';
    return JSON.parse(content);
  } catch (e) {
    console.log('[Gist] Error cargando seen.json:', e.message);
    return [];
  }
}

async function saveSeen(seen) {
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GIST_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          'seen.json': {
            content: JSON.stringify(seen, null, 2)
          }
        }
      })
    });
    if (!res.ok) console.log('[Gist] Error guardando:', res.status);
    else console.log(`[Gist] seen.json guardado (${seen.length} entradas)`);
  } catch (e) {
    console.log('[Gist] Error guardando seen.json:', e.message);
  }
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
function randomDelay(min = 3000, max = 7000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

// ---------------- DISCORD ----------------
async function sendDiscordBatch(products) {
  if (!WEBHOOK_URL) { console.log('[Discord] Sin webhook.'); return; }
  if (products.length === 0) return;

  const CHUNK_SIZE = 10;
  for (let i = 0; i < products.length; i += CHUNK_SIZE) {
    const chunk = products.slice(i, i + CHUNK_SIZE);
    const isFirst = i === 0;

    const embeds = chunk.map((p, idx) => ({
      title: p.title.slice(0, 256),
      url: p.href,
      color: 16753920,
      image: p.image ? { url: p.image } : undefined,
      fields: [
        { name: '💶 Precio', value: p.price, inline: true },
        { name: '⏳ Tiempo restante', value: p.timeLeft || 'No disponible', inline: true }
      ],
      footer: idx === chunk.length - 1
        ? { text: `Jobalots Bot • ${products.length} producto${products.length !== 1 ? 's' : ''} nuevo${products.length !== 1 ? 's' : ''}` }
        : undefined,
      timestamp: idx === chunk.length - 1 ? new Date().toISOString() : undefined
    }));

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: isFirst
            ? `🔔 **${products.length} producto${products.length !== 1 ? 's' : ''} nuevo${products.length !== 1 ? 's' : ''}** encontrado${products.length !== 1 ? 's' : ''}:`
            : undefined,
          embeds
        })
      });
      if (!res.ok) console.log('[Discord] Error:', res.status, await res.text());
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.log('[Discord] Fallo:', e.message);
    }
  }
}

// ---------------- SCROLL ----------------
async function autoScroll(page) {
  let previousHeight = 0;
  while (true) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    // Esperar 2 segundos para que cargue el nuevo contenido
    await page.waitForTimeout(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    // Si la pagina no ha crecido, hemos llegado al final
    if (newHeight === previousHeight) break;
    previousHeight = newHeight;
  }
  // Pausa final para asegurar que todo esta cargado
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
        i.src && !i.src.includes('logo') && !i.src.includes('icon') &&
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
        '[class*="ends-in"]', '[class*="remaining"]', '[class*="clock"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.innerText?.trim()) return el.innerText.trim();
      }
      for (const el of [...document.querySelectorAll('*')]) {
        if (el.children.length > 0) continue;
        const t = (el.innerText || '').toLowerCase();
        if (
          (t.includes('ends') || t.includes('closes') || t.includes('left') ||
           t.includes('remaining') || t.includes('days') || t.includes('hours')) &&
          /\d/.test(t) && t.length < 80
        ) return el.innerText.trim();
      }
      return null;
    });
  } catch { return null; }
}

// ---------------- PRECIO EN EUROS ----------------
async function extractPriceEur(page) {
  try {
    const priceText = await page.evaluate(() => {
      const allText = [...document.querySelectorAll('*')]
        .filter(el => el.children.length === 0)
        .map(el => el.innerText || '')
        .join(' ');
      const eurMatch = allText.match(/€\s?[0-9]+([.,][0-9]+)?/);
      if (eurMatch) return eurMatch[0];
      const gbpMatch = allText.match(/£\s?[0-9]+([.,][0-9]+)?/);
      if (gbpMatch) return gbpMatch[0];
      return null;
    });

    if (!priceText) return 'No disponible';
    if (priceText.includes('€')) return priceText;

    const GBP_TO_EUR = 1.17;
    const num = parseFloat(priceText.replace(/[£,\s]/g, ''));
    if (isNaN(num)) return priceText;
    const eur = (num * GBP_TO_EUR).toFixed(2);
    return `€${eur} (≈ ${priceText})`;
  } catch { return 'No disponible'; }
}

// ---------------- LINKS ----------------
async function collectProductLinks(page) {
  await autoScroll(page);
  const links = await page.$$eval('a', anchors =>
    anchors.map(a => a.href).filter(href =>
      href && href.includes('jobalots.com') &&
      (href.includes('/products/') || href.includes('/lots/') || href.includes('/auction/'))
    )
  );
  return [...new Set(links)];
}

// ---------------- MAIN ----------------
(async () => {
  const config = loadConfig();
  const seen   = await loadSeen();

  console.log('=== BOT JOBALOTS ===');
  console.log('Filtros:', config.keywords.length > 0 ? config.keywords.join(', ') : 'ninguno (todos)');
  console.log('Precio mínimo: €' + (config.minPrice || 0));
  console.log('Productos ya vistos:', seen.length);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' }
  });
  const page = await context.newPage();

  try {
    console.log('\n[1/3] Cargando página de subastas...');
    await page.goto(
      'https://jobalots.com/es/pages/products-on-auction?page=1&currency=eur&type=parcels&sort_by=auction_ending_latest',
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    await page.waitForTimeout(3000);

    const productLinks = await collectProductLinks(page);
    const newLinks = productLinks
      .filter(href => !seen.includes(href))
      .slice(0, MAX_NEW_PER_RUN);

    console.log(`[2/3] Total: ${productLinks.length} | Nuevos a revisar: ${newLinks.length}`);

    if (newLinks.length === 0) {
      console.log('Sin productos nuevos. Fin.');
      await browser.close();
      return;
    }

    const toNotify = [];

    console.log('\n[3/3] Analizando productos...');
    for (let i = 0; i < newLinks.length; i++) {
      const href = newLinks[i];
      console.log(`  [${i + 1}/${newLinks.length}] ${href}`);

      try {
        await page.goto(`${href}?currency=eur`.replace('/en/products/', '/es/products/'), { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        const text  = await page.evaluate(() => document.body?.innerText || '');
        const title = await page.title();

        // Marcar visto siempre
        seen.push(href);

        // Filtro palabras clave
        if (!matches(`${title} ${text}`, config.keywords)) {
          console.log(`    → Descartado (keywords)`);
          await randomDelay(2000, 4000);
          continue;
        }

        // Filtro precio mínimo
        const price = await extractPriceEur(page);
        if (config.minPrice > 0) {
          const num = parseFloat(price.replace(/[€£,\s(≈)a-zA-Z]/g, '').trim());
          if (!isNaN(num) && num < config.minPrice) {
            console.log(`    → Descartado (precio ${price} < mín €${config.minPrice})`);
            await randomDelay(2000, 4000);
            continue;
          }
        }

        const image    = await extractImage(page);
        const timeLeft = await extractTimeLeft(page);

        console.log(`    → ✅ INCLUIDO: ${title} | ${price} | ${timeLeft || 'sin tiempo'}`);
        toNotify.push({ href, title, price, image, timeLeft });

        await randomDelay(3000, 6000);

      } catch (e) {
        console.log(`    → ERROR: ${e.message}`);
        seen.push(href);
        await randomDelay(8000, 15000);
      }
    }

    // Guardar seen actualizado en el Gist
    await saveSeen(seen);

    // Enviar todo a Discord en un solo mensaje
    if (toNotify.length > 0) {
      console.log(`\nEnviando ${toNotify.length} producto(s) a Discord...`);
      await sendDiscordBatch(toNotify);
      console.log('✅ Enviado.');
    } else {
      console.log('\nNingún producto pasó los filtros.');
    }

  } catch (e) {
    console.log('[ERROR general]', e.message);
    await saveSeen(seen);
  } finally {
    await browser.close();
  }

  console.log('\n=== FIN ===');
})();
