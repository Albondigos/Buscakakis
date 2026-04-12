const { chromium } = require('playwright');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
const SEEN_FILE   = './seen.json';
const CONFIG_FILE = './config.json';

// Máximo de productos nuevos a procesar por ejecución
const MAX_NEW_PER_RUN = 15;

// ---------------- CONFIG ----------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { keywords: [], minPrice: 0 };
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

// ---------------- UTIL ----------------
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
// Envía todos los productos en un solo mensaje con múltiples embeds
// Discord permite hasta 10 embeds por mensaje
async function sendDiscordBatch(products) {
  if (!WEBHOOK_URL) { console.log('[Discord] Sin webhook.'); return; }
  if (products.length === 0) return;

  // Discord permite máx 10 embeds por mensaje, así que si hay más los partimos
  const CHUNK_SIZE = 10;
  for (let i = 0; i < products.length; i += CHUNK_SIZE) {
    const chunk = products.slice(i, i + CHUNK_SIZE);
    const isFirst = i === 0;

    const embeds = chunk.map((p, idx) => {
      const fields = [
        { name: '💶 Precio', value: p.price, inline: true },
        { name: '⏳ Tiempo restante', value: p.timeLeft || 'No disponible', inline: true }
      ];

      return {
        title: `${p.title.slice(0, 256)}`,
        url: p.href,
        color: 16753920,
        image: p.image ? { url: p.image } : undefined,
        fields,
        footer: idx === chunk.length - 1
          ? { text: `Jobalots Bot • ${products.length} producto${products.length !== 1 ? 's' : ''} nuevo${products.length !== 1 ? 's' : ''}` }
          : undefined,
        timestamp: idx === chunk.length - 1 ? new Date().toISOString() : undefined
      };
    });

    const payload = {
      content: isFirst
        ? `🔔 **${products.length} producto${products.length !== 1 ? 's' : ''} nuevo${products.length !== 1 ? 's' : ''}** encontrado${products.length !== 1 ? 's' : ''}:`
        : undefined,
      embeds
    };

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) console.log('[Discord] Error:', res.status, await res.text());
      // Pausa entre chunks para no saturar Discord
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.log('[Discord] Fallo:', e.message);
    }
  }
}

// ---------------- SCROLL ----------------
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const dist = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, dist);
        total += dist;
        if (total >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
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
      // Selectores específicos de countdown
      const selectors = [
        '[class*="countdown"]', '[class*="timer"]', '[class*="time-left"]',
        '[class*="time_left"]', '[data-countdown]', '[class*="auction-time"]',
        '[class*="ends-in"]', '[class*="remaining"]', '[class*="clock"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.innerText?.trim()) return el.innerText.trim();
      }
      // Búsqueda por contenido de texto
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
    // Intentar obtener el precio en euros directamente de la página
    // (si la URL ya tiene currency=eur o hay un selector de precio en €)
    const priceText = await page.evaluate(() => {
      // Buscar precio en euros primero
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

    // Si el precio ya está en euros, devolverlo tal cual
    if (priceText.includes('€')) return priceText;

    // Si está en libras, convertir a euros (tipo de cambio aprox)
    // Nota: tasa de cambio hardcodeada, suficientemente precisa para orientación
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
  const seen   = loadSeen();

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
      'https://jobalots.com/en/pages/products-on-auction?currency=eur',
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    await page.waitForTimeout(3000);

    const productLinks = await collectProductLinks(page);
    const newLinks = productLinks
      .filter(href => !seen.includes(href))
      .slice(0, MAX_NEW_PER_RUN);

    console.log(`[2/3] Total encontrados: ${productLinks.length} | Nuevos a revisar: ${newLinks.length}`);

    if (newLinks.length === 0) {
      console.log('Sin productos nuevos. Fin.');
      await browser.close();
      return;
    }

    // Acumular productos que pasan los filtros
    const toNotify = [];

    console.log('\n[3/3] Analizando productos nuevos...');
    for (let i = 0; i < newLinks.length; i++) {
      const href = newLinks[i];
      console.log(`  [${i + 1}/${newLinks.length}] ${href}`);

      try {
        await page.goto(`${href}?currency=eur`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        const text  = await page.evaluate(() => document.body?.innerText || '');
        const title = await page.title();

        // Marcar como visto siempre, pase o no el filtro
        seen.push(href);
        saveSeen(seen);

        // Filtro palabras clave
        if (!matches(`${title} ${text}`, config.keywords)) {
          console.log(`    → Descartado (no coincide con keywords)`);
          await randomDelay(2000, 4000);
          continue;
        }

        // Extraer precio en euros
        const price = await extractPriceEur(page);

        // Filtro precio mínimo (en euros)
        if (config.minPrice > 0) {
          const numStr = price.replace(/[€£,\s(≈)]/g, '').split(' ')[0];
          const num = parseFloat(numStr);
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
        saveSeen(seen);
        await randomDelay(8000, 15000);
      }
    }

    // Enviar todos los productos en un solo mensaje de Discord
    if (toNotify.length > 0) {
      console.log(`\nEnviando ${toNotify.length} producto(s) a Discord en un solo mensaje...`);
      await sendDiscordBatch(toNotify);
      console.log('✅ Mensaje enviado.');
    } else {
      console.log('\nNingún producto pasó los filtros. No se envía nada a Discord.');
    }

  } catch (e) {
    console.log('[ERROR general]', e.message);
  } finally {
    await browser.close();
  }

  console.log('\n=== FIN ===');
})();
