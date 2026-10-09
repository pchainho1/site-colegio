/**
 * Importa o site atual (www.colegio-falcao.com) para site/, para o build o servir com o mesmo aspeto.
 * Corre-se à mão, só quando for preciso voltar a copiar o site atual:  node tools/import-site.mjs
 *
 * - Percorre todas as páginas a partir de / e /en, seguindo os links internos.
 * - Guarda cada página em site/pages/<caminho>.html, já limpa: sem Google Tag Manager/Analytics,
 *   sem o carregador de CSS/JS do CMS (o build põe os ficheiros locais) e com endereços relativos.
 * - Imagens: guarda só as variantes WebP (cada ecrã tem o seu corte); as de recurso JPG/PNG
 *   (usadas abaixo de 768px) são convertidas para WebP. Ficam em site/img/<hash>.webp.
 * - Ícones, fontes e PDFs ficam no mesmo caminho que tinham (site/files/...).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const BASE = 'https://www.colegio-falcao.com';
const OUT = 'site';
const UA = { 'user-agent': 'Mozilla/5.0 (importador do site do Colegio Parque do Falcao)' };
const RESIZED = /^\/(storage\/app\/media\/imageresizecache|imageresize)\//;

const get = async (url, kind = 'text') => {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return kind === 'text' ? await r.text() : Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i === 3) throw new Error(url + ': ' + e.message); await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
};
const write = async (f, data) => { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, data); };
const local = u => u.startsWith(BASE) ? u.slice(BASE.length) || '/' : u;
const imgName = u => crypto.createHash('sha1').update(u).digest('hex').slice(0, 20) + '.webp';

/* ---------- 1. percorrer páginas ---------- */
const pages = new Map();            // caminho -> html original
const queue = ['/', '/en', '/blog', '/en/blog'];
const isPage = p => p.startsWith('/') && !/\.[a-z0-9]{2,5}$/i.test(p.split('?')[0]) && !/^\/(storage|themes|plugins|combine|imageresize)\b/.test(p);
while (queue.length) {
  const p = queue.shift();
  const key = p.replace(/\/$/, '') || '/';
  if (pages.has(key)) continue;
  let html;
  try { html = await get(BASE + key); } catch (e) { console.warn(`\n  link partido no site atual: ${key} (${e.message.split(': ').pop()})`); pages.set(key, null); continue; }
  pages.set(key, html);
  process.stdout.write(`\r${pages.size} páginas `);
  for (const [, href] of html.matchAll(/href="([^"#]+)"/g)) {
    const l = local(href.replace(/&amp;/g, '&'));
    if (!isPage(l)) continue;
    const [pp, q] = l.split('?');
    if (q && !/^page=\d+$/.test(q)) continue;          // só a paginação do blog
    queue.push(q ? l : pp);
  }
}
console.log();

/* ---------- 2. limpar páginas e recolher ficheiros ---------- */
const images = new Map();           // url remoto -> { name, convert }
const files = new Set();            // caminhos locais a copiar tal e qual
const addFile = u => { const l = local(u).split('?')[0].split('#')[0]; if (l.startsWith('/')) files.add(decodeURI(l)); return encodeURI(decodeURI(l)); };

function cleanPicture(pic) {
  // fontes WebP ficam; fontes JPG/PNG (duplicados para browsers antigos) saem
  pic = pic.replace(/<source\b[^>]*>/g, s => {
    if (!/type="image\/webp"/.test(s)) return '';
    return s.replace(/(data-srcset|srcset)="([^"]+)"/g, (m, a, v) => `${a}="${v.split(',').map(x => {
      const [u, d] = x.trim().split(/\s+/); images.set(u, { name: imgName(u) }); return `/img/${imgName(u)}${d ? ' ' + d : ''}`;
    }).join(', ')}"`);
  });
  return pic;
}

function clean(html) {
  // cabeçalho: tira o GTM/Analytics, o modernizr (fica a classe webp fixa) e o carregador do CMS
  html = html.replace(/<html lang="([a-z]+)"[^>]*>/, '<html lang="$1" class="webp">');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, s =>
    /application\/ld\+json/.test(s) ? s
      : /window\.BASE_URL/.test(s) ? s.replace(/"https:\/\/www\.colegio-falcao\.com\/"/g, 'location.origin')   // usado pelo JS do tema (BASE_URL + '/themes/...')
      : '');
  html = html.replace(/<noscript id="extra_scripts">[\s\S]*?<\/noscript>/, '');
  html = html.replace(/<noscript id="extra_styles">([\s\S]*?)<\/noscript>/, (m, c) => '<!--EXTRA_STYLES-->' + (c.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join(''));
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
  html = html.replace(/<link rel="preconnect"[^>]*>/g, '');
  html = html.replace(/<link href="[^"]*(bootstrap|combine)[^"]*" rel="stylesheet"[^>]*>/g, '');
  html = html.replace(/<\/head>/, '<!--ASSETS--></head>');

  // imagens redimensionadas pelo CMS
  html = html.replace(/<picture\b[\s\S]*?<\/picture>/g, cleanPicture);
  html = html.replace(/(data-src|src|data-srcset|srcset|content)="(https:\/\/www\.colegio-falcao\.com\/(?:storage\/app\/media\/imageresizecache|imageresize)\/[^"]+)"/g, (m, a, u) => {
    // listas "url 1x, url 2x" (fontes fora de <picture>): trata cada endereço
    return `${a}="${u.split(',').map(x => {
      const [v, d] = x.trim().split(/\s+/);
      images.set(v, { name: imgName(v), convert: !/\.webp$/.test(v) }); return `/img/${imgName(v)}${d ? ' ' + d : ''}`;
    }).join(', ')}"`;
  });
  // restantes ficheiros do domínio (ícones, PDFs, imagens da media) e links internos
  html = html.replace(/(href|src|data-src|content)="(https:\/\/www\.colegio-falcao\.com[^"]*)"/g, (m, a, u) => {
    const l = local(u);
    if (a === 'content') return m;                                  // og:url, og:image: o build trata
    if (/\.[a-z0-9]{2,5}(\?|$)/i.test(l.split('#')[0]) && !isPage(l.split('?')[0])) return `${a}="${addFile(u)}"`;
    return `${a}="${l.replace(/\?page=(\d+)/, '/pagina/$1')}"`;
  });
  // ficheiros já referidos com caminho relativo (ex.: ícones em /storage/app/media/icons)
  html = html.replace(/(href|src|data-src|data-srcset|srcset)="(\/(?:storage|themes|plugins)\/[^"]+)"/gi, (m, a, v) =>
    RESIZED.test(v) ? m : `${a}="${v.split(/,\s*/).map(x => { const [u, d] = x.trim().split(/\s+/); return addFile(BASE + u) + (d ? ' ' + d : ''); }).join(', ')}"`);
  // url(...) em estilos dentro da página (ex.: @font-face): caminho relativo e ficheiro copiado
  html = html.replace(/url\((['"]?)https:\/\/www\.colegio-falcao\.com(\/[^'")]+)\1\)/g, (m, q, u) => `url(${q}${addFile(BASE + u)}${q})`);
  return html;
}

for (const [p, h] of pages) if (h === null) pages.delete(p);
// página de erro (o site devolve-a com estado 404)
pages.set('/404', await (await fetch(BASE + '/esta-pagina-nao-existe', { headers: UA })).text());
const cleaned = new Map([...pages].map(([p, h]) => [p, clean(h)]));
for (const [p, h] of cleaned) {
  if (/\?page=/.test(p)) continue;                                   // paginação do blog: o build gera
  await write(path.join(OUT, 'pages', (p === '/' ? '/index' : p) + '.html'), h);
}
console.log(`${cleaned.size} páginas limpas`);

// cartões do blog (listagem paginada) e resumos (notícias da página inicial), por língua
const txt = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const posts = { pt: [], en: [] }, excerpts = {};
for (const [p, h] of cleaned) {
  const lang = p.startsWith('/en') ? 'en' : 'pt';
  if (/^(\/en)?\/blog(\?page=\d+)?$/.test(p)) {
    for (const [, href, pic, title, date] of h.matchAll(/<div class="news-card"><a href="([^"]+)"><span class="news-image"><picture>([\s\S]*?)<\/picture><\/span><span class="text-container"><span class="news-title"><span>([\s\S]*?)<\/span><\/span><span class="news-date"><span>([\s\S]*?)<\/span>/g))
      if (!posts[lang].some(x => x.href === href)) posts[lang].push({ href, pic, title: txt(title), date: txt(date) });
  }
  if (p === '/' || p === '/en')
    for (const [, href, t] of h.matchAll(/<div class="news-card"><a href="([^"]+)">[\s\S]*?<span class="news-txt"><span>([\s\S]*?)<\/span>/g)) excerpts[href] = txt(t);
}
await write(path.join(OUT, 'posts.json'), JSON.stringify({ ...posts, excerpts }, null, 1));
console.log(`blog: ${posts.pt.length} artigos (pt), ${posts.en.length} (en), ${Object.keys(excerpts).length} resumos`);

/* ---------- 3. CSS e JS do tema ---------- */
const home = pages.get('/');
const combined = [...new Set(home.match(/https:\/\/www\.colegio-falcao\.com\/combine\/[a-f0-9]+-\d+/g))];
const css = home.match(/https:\/\/www\.colegio-falcao\.com\/combine\/[a-f0-9]+-\d+(?=\?ck=[^"]*" rel="stylesheet")/)[0];
const js = combined.find(u => u !== css);
let themeCss = await get(css);
themeCss = themeCss.replace(/url\((['"]?)\.\.\/([^'")]+)\1\)/g, (m, q, u) => `url(${q}${addFile(BASE + '/' + u)}${q})`);   // relativos a /combine/
themeCss = themeCss.replace(/url\((['"]?)(https:\/\/www\.colegio-falcao\.com[^'")]+|\/[^'")]+)\1\)/g, (m, q, u) => `url(${q}${addFile(u.startsWith('http') ? u : BASE + u)}${q})`);
await write(path.join(OUT, 'assets', 'theme.css'), themeCss);
const themeJs = await get(js);
for (const [, u] of themeJs.matchAll(/'(\/(?:themes|storage)\/[^']+\.[a-z0-9]{2,5})'/g)) addFile(BASE + u);   // ex.: ícone do mapa
await write(path.join(OUT, 'assets', 'theme.js'), themeJs);
console.log('tema:', css, js);

/* ---------- 4. ficheiros e imagens ---------- */
let n = 0;
for (const f of files) {
  const dest = path.join(OUT, 'files', f);
  try { await fs.access(dest); continue; } catch {}
  try { await write(dest, await get(BASE + encodeURI(f), 'buf')); n++; } catch (e) { console.warn('  falhou', f, e.message); }
}
console.log(`${n} ficheiros novos (${files.size} no total)`);

const queueImg = [...images].filter(([, v]) => v.name);
let done = 0, bytes = 0;
async function worker() {
  while (queueImg.length) {
    const [u, { name, convert }] = queueImg.shift();
    const dest = path.join(OUT, 'img', name);
    try { await fs.access(dest); done++; continue; } catch {}
    try {
      let b = await get(u, 'buf');
      if (convert) b = await sharp(b).webp({ quality: 78, alphaQuality: 90 }).toBuffer();
      await write(dest, b); bytes += b.length; done++;
      if (done % 50 === 0) process.stdout.write(`\r${done}/${images.size} imagens, ${(bytes / 1048576).toFixed(0)} MB novos `);
    } catch (e) { console.warn('\n  imagem falhou', u, e.message); }
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
console.log(`\n${done}/${images.size} imagens (${(bytes / 1048576).toFixed(0)} MB novos)`);
