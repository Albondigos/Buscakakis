const { chromium } = require('playwright');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
const SEEN_FILE = './seen.json';
const CONFIG_FILE = './config.json';

// Intervalo entre ciclos completos de scraping (ms)
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

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
  if (!keywords || keywords.length === 0) return true;
  const t = normalize(text);
  return keywords.some(k => t.includes(normalize(k)));
}

// ---------------- DISCORD ----------------
async function sendDiscord(payload) {
  if (!WEBHOOK_URL) {
    console.log('[Discord] Sin webhook configurado, saltando envío');
    return;
  }
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log('[Discord] Error HTTP:', res.status, await res.text());
    }
  } catch (e) {
    console.log('[Discord] Fallo de red:', e.message);
  }
}

// ---------------- SCROLL PARA CARGAR TODOS LOS PRODUCTOS ----------------
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
  // Espera a que se cargue contenido lazy
  await page.waitForTimeout(2000);
}

// ---------------- EXTRAER IMAGEN (og:image primero) ----------------
async function extractImage(page) {
  try {
    return await page.evaluate(() => {
      // 1. og:image es la mejor opción (imagen principal del producto)
      const og = document.querySelector('meta[property="og:image"]');
      if (og && og.content) return og.content;

      // 2. Twitter image como fallback
      const tw = document.querySelector('meta[name="twitter:image"]');
      if (tw && tw.content) return tw.content;

      // 3. Primera imagen del producto (evitar logos/iconos pequeños)
      const imgs = [...document.querySelectorAll('img')];
      const productImg = imgs.find(img => {
        const src = img.src || '';
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        // Ignorar imágenes muy pequeñas o SVGs de icono
        return src && !src.includes('logo') && !src.includes('icon') && (w > 100 || h > 100 || w === 0);
      });
      return productImg?.src || null;
    });
  } catch {
    return null;
  }
}

// ---------------- EXTRAER TIEMPO RESTANTE ----------------
async function extractTimeLeft(page) {
  try {
    return await page.evaluate(() => {
      // Jobalots suele usar elementos con clases de countdown
      const selectors = [
        '[class*="countdown"]',
        '[class*="timer"]',
        '[class*="time-left"]',
        '[class*="time_left"]',
        '[data-countdown]',
        '[class*="auction-time"]',
        '[class*="ends-in"]',
        '[class*="remaining"]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 0) {
          return el.innerText.trim();
        }
      }
      // Búsqueda por texto: "ends in", "time left", "closes in"
      const all = [...document.querySelectorAll('*')];
      for (const el of all) {
        if (el.children.length > 0) continue; // solo nodos hoja
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
  } catch {
    return null;
  }
}

// ---------------- EXTRAER PRECIO ----------------
function extractPrice(text) {
  // Intenta capturar el precio en GBP o EUR
  const match = text.match(/[£€]\s?[0-9]+([.,][0-9]+)?/);
  return match ? match[0] : null;
}

// ---------------- RECOGER LINKS DE PRODUCTOS ----------------
async function collectProductLinks(page) {
  // Scroll completo para activar lazy loading
  await autoScroll(page);

  const links = await page.$$eval('a', anchors =>
    anchors
      .map(a => a.href)
      .filter(href =>
        href &&
        href.includes('jobalots.com') &&
        (href.includes('/products/') || href.includes('/lots/') || href.includes('/auction/'))
      )
  );

  // Deduplicar
  return [...new Set(links)];
}

// ---------------- CICLO DE SCRAPING ----------------
async function runCycle(browser, seen, config) {
  console.log(`\n[${new Date().toISOString()}] Iniciando ciclo...`);

  const page = await browser.newPage();
  // User-agent más realista para evitar bloqueos
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-GB,en;q=0.9',
  });

  try {
    await page.goto(
      'https://jobalots.com/en/pages/products-on-auction?currency=gbp',
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await page.waitForTimeout(3000);

    const productLinks = await collectProductLinks(page);
    console.log(`[Scraper] Total links encontrados: ${productLinks.length}`);

    const newLinks = productLinks.filter(href => !seen.includes(href));
    console.log(`[Scraper] Nuevos (no vistos): ${newLinks.length}`);

    for (const href of newLinks) {
      try {
        const p = await browser.newPage();
        await p.goto(href, { waitUntil: 'networkidle', timeout: 30000 });
        await p.waitForTimeout(2000);

        const text = await p.evaluate(() => document.body?.innerText || '');
        const title = await p.title();
        const full = `${title} ${text}`;

        // Aplicar filtros
        if (!matches(full, config.keywords)) {
          await p.close();
          continue;
        }

        const image = await extractImage(p);
        const price = extractPrice(text) || 'No detectado';
        const timeLeft = await extractTimeLeft(p);

        console.log(`[Nuevo] ${title} | Precio: ${price} | Tiempo: ${timeLeft || 'N/D'}`);

        const fields = [
          { name: '💰 Precio', value: price, inline: true }
        ];
        if (timeLeft) {
          fields.push({ name: '⏳ Tiempo restante', value: timeLeft, inline: true });
        }

        await sendDiscord({
          embeds: [
            {
              title: `🔥 ${title.slice(0, 256)}`,
              url: href,
              color: 16753920, // naranja
              // La imagen debe ir en "image" (no "thumbnail") para que Discord la muestre grande
              image: image ? { url: image } : undefined,
              // thumbnail también incluido por compatibilidad
              thumbnail: image ? { url: image } : undefined,
              fields,
              footer: {
                text: 'Jobalots Bot'
              },
              timestamp: new Date().toISOString()
            }
          ]
        });

        seen.push(href);
        saveSeen(seen);
        await p.close();

        // Pausa entre productos para no saturar Discord ni el servidor
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.log(`[ERROR producto] ${href}: ${e.message}`);
      }
    }
  } catch (e) {
    console.log('[ERROR ciclo]', e.message);
  } finally {
    await page.close();
  }

  console.log(`[${new Date().toISOString()}] Ciclo finalizado. Próximo en ${POLL_INTERVAL_MS / 60000} min.`);
}

// ---------------- MAIN (LOOP INFINITO) ----------------
(async () => {
  const config = loadConfig();
  const seen = loadSeen();

  console.log('=== BOT JOBALOTS ARRANCADO ===');
  console.log('FILTROS:', config);

  await sendDiscord({
    embeds: [{
      title: '✅ Bot Jobalots arrancado',
      description: `Monitorizando subastas cada ${POLL_INTERVAL_MS / 60000} minutos.\nFiltros activos: ${config.keywords.length > 0 ? config.keywords.join(', ') : 'ninguno (todos los productos)'}`,
      color: 3066993,
      timestamp: new Date().toISOString()
    }]
  });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // Bucle principal: corre indefinidamente
  while (true) {
    await runCycle(browser, seen, config);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Nunca se llega aquí, pero por si acaso:
  // await browser.close();
})();
