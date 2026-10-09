/**
 * Gera o site estático do Colégio Parque do Falcão em dist/, com o aspeto do site atual.
 *
 * - As páginas e imagens do site atual estão em site/ (importadas com tools/import-site.mjs).
 * - O blog junta os artigos importados do site atual com os novos do Google Drive (feed do Apps Script):
 *   do Drive só entram os meses depois de ARCHIVE_UNTIL, para não duplicar os que já estavam no site.
 *
 * Variáveis de ambiente
 *   FEED_URL   URL da Aplicação Web do blog-feed-drive.gs, terminado em /exec (sem ela usa feed.sample.json)
 *   FEED_KEY   chave partilhada com o Apps Script (Propriedades do script > FEED_KEY); guardar como secret
 *   SITE_URL   endereço final do site (para canonical, sitemap e partilha)
 *   PHOTO_DIR  pasta local com fotos (só para testes, evita descarregar)
 *   (os textos, fotos e PDFs das páginas também vêm do Drive pelo mesmo Apps Script: pasta "Site do colégio")
 *   CF_BEACON_TOKEN  token do Cloudflare Web Analytics (estatísticas sem cookies); sem ele não há estatísticas
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PurgeCSS } from 'purgecss';
import { parse } from 'node-html-parser';

const SITE = (process.env.SITE_URL || 'https://novo.parque-falcao.com').replace(/\/$/, '');
// Só conta se for um endereço https/http; qualquer outro valor (ou nada) usa feed.sample.json
const FEED_URL = /^https?:\/\//.test(process.env.FEED_URL || '') ? process.env.FEED_URL : undefined;
const FEED_KEY = process.env.FEED_KEY || '';
const PHOTO_DIR = process.env.PHOTO_DIR;
const OLD_SITE = 'https://www.colegio-falcao.com';
const ARCHIVE_UNTIL = '2026-06';   // último mês publicado no site antigo (os artigos até aqui vêm de site/)
const PER_PAGE = 6;                // artigos por página na listagem do blog (como no site atual)
const NEWS_ON_HOME = 8;            // artigos no carrossel "Notícias & Eventos"
const WIDTHS = [640, 1200, 1800];
const PLACEHOLDER = '/themes/abddcms/assets/img/tools/preloading_img.svg';
const ARROW = '/themes/abddcms/assets/img/icons/arrow_right_icon.svg';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (t, n) => t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;
const write = async (p, c) => { const f = path.join('dist', p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, c); };
const read = p => fs.readFile(path.join('site', p), 'utf8');

/* ---------- feed do Drive ---------- */
// Pedido ao Apps Script com a chave; o feed é sempre regenerado (refresh=1), as fotos não
async function fromScript(params) {
  const u = new URL(FEED_URL);
  u.searchParams.delete('refresh');
  if (FEED_KEY) u.searchParams.set('key', FEED_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { redirect: 'follow' });
  if (!r.ok) throw new Error('Apps Script indisponível: HTTP ' + r.status);
  const data = await r.json();
  if (data.error) throw new Error('Apps Script: ' + data.error + (data.error === 'acesso negado' ? ' (verifique FEED_KEY)' : ''));
  return data;
}

async function loadFeed() {
  let data;
  if (FEED_URL) data = await fromScript({ refresh: '1' });
  else {
    data = JSON.parse(await fs.readFile('feed.sample.json', 'utf8'));
    // O feed de exemplo aponta para fotos reais ainda sem autorização confirmada: nunca as publicar.
    // Só entram fotos com PHOTO_DIR (testes locais).
    if (!PHOTO_DIR) data.posts.forEach(p => { p.photos = []; });
  }
  return data.posts.filter(p => p.status === 'published').sort((a, b) => b.sort.localeCompare(a.sort));
}

async function getBuffer(f) {
  if (PHOTO_DIR) { try { return await fs.readFile(path.join(PHOTO_DIR, f.name)); } catch {} }
  const cp = path.join('.cache', f.driveId + '.img');
  try { return await fs.readFile(cp); } catch {}
  let b;
  if (FEED_URL) b = Buffer.from((await fromScript({ photo: f.driveId })).data, 'base64');
  else {
    const r = await fetch(`https://lh3.googleusercontent.com/d/${f.driveId}=w2000`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    b = Buffer.from(await r.arrayBuffer());
  }
  await fs.mkdir('.cache', { recursive: true }); await fs.writeFile(cp, b);
  return b;
}

async function processPhotos(post) {
  const photos = [...(post.photos || [])].sort((a, b) => (b.name === post.cover) - (a.name === post.cover));
  const out = [];
  for (const [i, f] of photos.entries()) {
    try {
      const buf = await getBuffer(f);
      const dir = path.join('dist', 'img', post.slug);
      await fs.mkdir(dir, { recursive: true });
      const id = String(i + 1).padStart(2, '0'), variants = [];
      let ref;
      for (const w of WIDTHS) {
        const { data, info } = await sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer({ resolveWithObject: true });
        if (variants.some(v => v.width === info.width)) continue;
        await fs.writeFile(path.join(dir, `${id}-${w}.webp`), data);
        variants.push({ url: `/img/${post.slug}/${id}-${w}.webp`, width: info.width });
        if (w === 1200 || !ref) ref = info;
      }
      out.push({ variants, w: ref.width, h: ref.height });
    } catch (e) { console.warn(`  foto ignorada (${f.name}): ${e.message}`); }
  }
  post.imgs = out;
}
const imgTag = (im, sizes, alt) => {
  const mid = im.variants.find(v => v.width >= 1000) || im.variants[im.variants.length - 1];
  return `<img src="${mid.url}" srcset="${im.variants.map(v => `${v.url} ${v.width}w`).join(', ')}" sizes="${sizes}" width="${im.w}" height="${im.h}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
};

/* ---------- utilitários de HTML ---------- */
// substitui o conteúdo do elemento <div ...> que começa em `marker` (contando divs aninhadas)
function replaceDiv(html, marker, inner) {
  const a = html.indexOf(marker);
  if (a < 0) return html;
  const open = html.indexOf('>', a) + 1;
  let depth = 1, i = open;
  const re = /<div\b|<\/div>/g; re.lastIndex = open;
  for (let m; (m = re.exec(html));) { depth += m[0] === '</div>' ? -1 : 1; if (!depth) { i = m.index; break; } }
  return html.slice(0, open) + inner + html.slice(i);
}
const setMeta = (html, { title, desc }) => {
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)} | Colégio Parque do Falcão</title>`)
    .replace(/(<meta (?:name|property)="(?:title|twitter:title|og:title)" content=")[^"]*"/g, `$1${esc(title)} | Colégio Parque do Falcão"`);
  if (desc) html = html.replace(/(<meta (?:name|property)="(?:description|twitter:description|og:description)" content=")[^"]*"/g, `$1${esc(desc)}"`);
  return html;
};

const ASSETS = '<link rel="stylesheet" href="/assets/bootstrap.min.css"><link rel="stylesheet" href="/assets/theme.css">'
  + '<script defer src="/assets/jquery.min.js"></script><script defer src="/assets/theme.js"></script>';
// a primeira imagem do conteúdo (normalmente a maior, o LCP) carrega logo, sem esperar pelo JavaScript
function eagerFirst(html) {
  const a = html.indexOf('<picture', html.indexOf('<main'));
  if (a < 0) return html;
  const b = html.indexOf('</picture>', a);
  const pic = html.slice(a, b)
    .replace(/(<img\b[^>]*?)\s+src="[^"]*preloading_img\.svg"/, '$1')
    .replace(/\bdata-(srcset|src)=/g, '$1=')
    .replace(/(<img\b[^>]*?)class="lazy"/, '$1fetchpriority="high"')
    .replace(/class="lazy"/g, '');
  return html.slice(0, a) + pic + html.slice(b);
}
// O tema esconde a página (body com opacidade 0) até o JavaScript acrescentar "loaded": aqui a página
// aparece logo; só os slides seguintes de cada carrossel ficam escondidos até o carrossel arrancar.
const NO_FOUC = '<style>' + ['.hero-slider', '.know-us-slider', '.facilities-slider', '.text-slider-holder', '.news-slider', '.testimonials-slider', '.post-image-container', '.photos-slider']
  .map(c => `${c}:not(.slick-initialized)>*+*`).join(',') + '{display:none}</style>';
const showBody = html => html.replace(/<body\b([^>]*)>/, (m, attrs) => /class="/.test(attrs) ? `<body${attrs.replace(/class="/, 'class="loaded ')}>` : `<body${attrs} class="loaded">`);
// Mapa dos contactos: mapa incorporado do Google (sem chave de API; a do site atual só aceita colegio-falcao.com).
// Sem o elemento #map, o JavaScript do tema já não carrega a API do Google Maps.
const embedMap = html => html.replace(/<div id="map" data-lat="([^"]+)" data-lon="([^"]+)"><\/div>/, (m, lat, lon) =>
  `<iframe src="https://www.google.com/maps?q=${lat},${lon}&z=16&hl=${/<html lang="en"/.test(html) ? 'en' : 'pt-PT'}&output=embed" title="Mapa: Colégio Parque do Falcão" loading="lazy" referrerpolicy="no-referrer-when-downgrade" style="border:0;width:100%;height:100%;display:block"></iframe>`);
// Cloudflare Web Analytics: estatísticas sem cookies (não precisa de aviso de consentimento)
const BEACON = /^[a-f0-9]{32}$/i.test(process.env.CF_BEACON_TOKEN || '')
  ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${process.env.CF_BEACON_TOKEN}"}'></script>` : '';
// Idiomas: no site atual a troca PT/EN era feita pelo servidor do CMS (pedido "onSwitchLocale"), que não existe aqui.
// O botão passa a abrir a página equivalente no outro idioma. Os pares PT/EN vêm dos menus das páginas iniciais.
const LANG_PAIRS = new Map([['/', '/en']]);
function learnLangPairs(ptHome, enHome) {
  const links = h => [...h.matchAll(/href="(\/[^"#?]*)"/g)].map(m => m[1]).filter(u => !/^\/(storage|themes|img|assets)\/|\.[a-z0-9]{2,5}$/i.test(u));
  const [pt, en] = [links(ptHome), links(enHome)];
  if (pt.length !== en.length) return console.warn('  aviso: menus PT e EN diferentes, troca de idioma só por regras gerais');
  pt.forEach((u, i) => { if (u !== '/' && en[i].startsWith('/en')) LANG_PAIRS.set(u, en[i]); });
}
function otherLang(url) {
  if (url.startsWith('/en')) {
    for (const [pt, en] of LANG_PAIRS) if (en === url) return pt;
    return url.startsWith('/en/blog') ? url.slice(3) : '/';
  }
  return LANG_PAIRS.get(url) || (url.startsWith('/blog') ? '/en' + url : '/en');
}
const switchLang = (html, url) => {
  if (!url) return html;
  const other = otherLang(url), [pt, en] = url.startsWith('/en') ? [other, url] : [url, other];
  return html
    .replace(/ data-request="onSwitchLocale"/g, ` data-href="${other}"`)
    .replace('</head>', `<link rel="alternate" hreflang="pt" href="${SITE}${pt}"><link rel="alternate" hreflang="en" href="${SITE}${en}"></head>`)
    .replace('</body>', `<script>document.querySelectorAll('#toggle_lang').forEach(function(i){i.addEventListener('change',function(){location.href=i.dataset.href})})</script></body>`)
    // links partidos do site atual nas páginas EN (sem o prefixo /en)
    .replace(/href="\/(educational-offering|our-school)\//g, 'href="/en/$1/').replace('href="/en/educational-offering/1st-cycle"', 'href="/en/educational-offering/primary"');
};
/* ---------- conteúdo editável no Google Drive (pasta "Site do colégio") ---------- */
// site/content.json (tools/mark-content.mjs) diz que textos (data-t) e fotos (data-f) são editáveis e que PDFs existem.
// O Apps Script devolve o que está no Drive; aqui só se aplica o que mudou em relação ao site importado.
const CONTENT = JSON.parse(await fs.readFile('site/content.json', 'utf8'));
const textChanges = new Map();   // id -> texto novo
const imgChanges = new Map();    // /img/x.webp -> /img/x-<versão>.webp
const textHtml = t => esc(t).replace(/\n/g, '<br>');

async function loadDriveContent() {
  if (!FEED_URL) return;
  let live;
  try { live = await fromScript({ site: '1' }); } catch (e) { return console.warn('  conteúdo do Drive indisponível:', e.message); }
  if (!live.texts) return console.log('  pasta "Site do colégio" ainda não preparada no Apps Script');
  const original = new Map(CONTENT.docs.flatMap(d => [...d.pt.texts, ...d.en.texts]).map(t => [t.id, t.text]));
  for (const [id, t] of Object.entries(live.texts)) {
    const v = String(t).replace(/\r/g, '').split('\n').map(l => l.trim()).join('\n').trim();
    if (original.has(id) && v && v !== original.get(id)) textChanges.set(id, v);
  }
  for (const [id, f] of Object.entries(live.photos || {})) {
    const slot = CONTENT.photos[id];
    if (!slot || f.original) continue;
    try {
      const buf = Buffer.from((await fromScript({ file: f.fileId })).data, 'base64');
      const tag = f.fileId.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const u of slot.variants) {
        const { width, height } = await sharp(path.join('site', u)).metadata();   // mesmo tamanho e corte da original
        const nu = u.replace(/\.webp$/, `-${tag}.webp`);
        await sharp(buf).rotate().resize(width, height, { fit: 'cover' }).webp({ quality: 78 }).toFile(path.join('dist', nu));
        imgChanges.set(u, nu);
      }
    } catch (e) { console.warn(`  foto ${id} ignorada: ${e.message}`); }
  }
  for (const d of CONTENT.documents) {
    const f = (live.documents || {})[d.name];
    if (!f || f.original) continue;
    try { await fs.writeFile(path.join('dist', d.url), Buffer.from((await fromScript({ file: f.fileId })).data, 'base64')); }
    catch (e) { console.warn(`  documento ${d.name} ignorado: ${e.message}`); }
  }
  console.log(`Drive: ${textChanges.size} texto(s), ${new Set([...imgChanges.keys()].map(u => Object.keys(CONTENT.photos).find(k => CONTENT.photos[k].variants.includes(u)))).size} foto(s) e ${CONTENT.documents.filter(d => live.documents?.[d.name] && !live.documents[d.name].original).length} documento(s) alterados`);
}

function applyDrive(html) {
  if (textChanges.size && /data-t="/.test(html)) {
    const ids = [...html.matchAll(/data-t="([^"]+)"/g)].map(m => m[1]).filter(id => textChanges.has(id));
    if (ids.length) {
      const root = parse(html, { comment: true });
      for (const id of new Set(ids)) for (const e of root.querySelectorAll(`[data-t="${id}"]`)) e.set_content(textHtml(textChanges.get(id)));
      html = root.toString();
    }
  }
  for (const [a, b] of imgChanges) html = html.split(a).join(b);
  return html;
}

// manifesto público para o Apps Script preparar a pasta do Drive (textos atuais, fotos e PDFs a copiar)
async function writeManifest() {
  const largest = async urls => { let best; for (const u of urls) { const m = await sharp(path.join('site', u)).metadata(); if (!best || m.width > best.w) best = { u, w: m.width }; } return best.u; };
  const photos = [];
  for (const [id, p] of Object.entries(CONTENT.photos)) photos.push({ id, page: p.page, alt: p.alt, url: await largest(p.variants) });
  await write('site-content.json', JSON.stringify({ docs: CONTENT.docs.map(d => ({ title: d.title, pt: d.pt.texts, en: d.en.texts })), photos, documents: CONTENT.documents }));
}

const finish = (html, url) => switchLang(showBody(eagerFirst(embedMap(applyDrive(html)))), url).replace('</body>', BEACON + '</body>').replace('<!--ASSETS-->', ASSETS + NO_FOUC).replace('<!--EXTRA_STYLES-->', '').split(OLD_SITE).join(SITE)
  .replace(/content="\/img\//g, `content="${SITE}/img/`);

/* ---------- blog ---------- */
const newsCard = (p, lang, withTxt) => `<div class="news-card"><a href="${lang === 'en' ? '/en' : ''}${p.href}"><span class="news-image"><picture>${p.cardImg}</picture></span><span class="text-container"><span class="news-title"><span>${esc(p.title)}</span></span>${withTxt
  ? `<span class="news-txt"><span>${esc(p.excerpt)}</span></span>` : `<span class="news-date"><span>${esc(p.date)}</span></span>`}</span><span class="news-arrow"><img src="${ARROW}" alt=""></span></a></div>`;

function pagination(n, page, base) {
  const href = k => k === 1 ? base : `${base}/pagina/${k}`;
  const li = k => k === page ? `<li class="page-item active" aria-current="page"><span class="page-link">${k}</span></li>` : `<li class="page-item"><a class="page-link" href="${href(k)}">${k}</a></li>`;
  return `<nav><ul class="pagination">${page > 1 ? `<li class="page-item"><a class="page-link" href="${href(page - 1)}" rel="prev" aria-label="Anterior">&lsaquo;</a></li>` : ''}${Array.from({ length: n }, (_, i) => li(i + 1)).join('')}${page < n ? `<li class="page-item"><a class="page-link" href="${href(page + 1)}" rel="next" aria-label="Seguinte">&rsaquo;</a></li>` : ''}</ul></nav>`;
}

function postBody(p) {
  return p.intro.map(t => `<p>${esc(t)}</p>`).join('') + p.sections.map(s => `<h3>${esc(s.h)}</h3>${s.p.map(t => `<p>${esc(t)}</p>`).join('')}`).join('') + (p.closing ? `<p><strong>${esc(p.closing)}</strong></p>` : '');
}

async function main() {
  const t0 = Date.now();
  await fs.rm('dist', { recursive: true, force: true });

  // ficheiros estáticos: tema, bibliotecas, ícones, fontes, PDFs e imagens do site atual
  await fs.cp('site/files', 'dist', { recursive: true });
  await fs.cp('site/img', 'dist/img', { recursive: true });
  await fs.cp('site/assets', 'dist/assets', { recursive: true });
  await fs.copyFile('node_modules/bootstrap/dist/css/bootstrap.min.css', 'dist/assets/bootstrap.min.css');
  await fs.copyFile('node_modules/jquery/dist/jquery.min.js', 'dist/assets/jquery.min.js');

  // artigos: os importados (site antigo) + os do Drive depois de ARCHIVE_UNTIL
  await loadDriveContent();
  await writeManifest();
  const archive = JSON.parse(await read('posts.json'));
  const feed = (await loadFeed()).filter(p => p.sort > ARCHIVE_UNTIL);
  console.log(`${feed.length} artigo(s) novos do Drive`);
  for (const p of feed) { p.tags ||= []; p.intro ||= []; p.sections ||= []; p.closing ||= ''; console.log('·', p.month, `(${p.photos?.length || 0} fotos)`); await processPhotos(p); }
  const fromFeed = feed.map(p => ({
    href: `/blog/default/${p.slug}`, title: p.title, date: p.month, excerpt: clip(p.summary, 420), feed: p,
    cardImg: p.imgs.length ? imgTag(p.imgs[0], '(min-width:992px) 33vw, (min-width:768px) 50vw, 100vw', p.title) : `<img src="${PLACEHOLDER}" alt="">`,
  }));
  const blog = lang => [...fromFeed, ...archive[lang].map(a => ({
    ...a, href: a.href.replace(/^\/en/, ''), excerpt: archive.excerpts[a.href] || '',
    cardImg: a.pic,
  }))];

  // páginas importadas
  const pages = [];
  async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); e.isDirectory() ? await walk(f) : pages.push(f); } }
  await walk('site/pages');
  const tpl = {};
  learnLangPairs(await read('pages/index.html'), await read('pages/en.html'));
  for (const f of pages) {
    const url = '/' + path.relative('site/pages', f).replace(/\.html$/, '').replace(/^index$/, '');
    let html = await fs.readFile(f, 'utf8');
    const lang = url.startsWith('/en') ? 'en' : 'pt';
    if (lang === 'en') html = html.replace('<html lang="pt"', '<html lang="en"');   // o site atual marca as páginas EN como pt
    if (url === '/' || url === '/en') html = replaceDiv(html, '<div class="news-slider">', blog(lang).slice(0, NEWS_ON_HOME).map(p => newsCard(p, lang, true)).join(''));
    if (/^(\/en)?\/blog$/.test(url)) { tpl[lang + 'List'] = html; continue; }        // a listagem é gerada abaixo
    if (/\/blog\/default\//.test(url) && !tpl[lang + 'Post']) tpl[lang + 'Post'] = { html, slug: url.split('/').pop() };
    await write((url === '/' ? '/index' : url) + '.html', finish(html, url));
  }

  // listagem do blog, paginada como no site atual (/blog, /blog/pagina/2, ...)
  for (const lang of ['pt', 'en']) {
    const list = blog(lang), base = (lang === 'en' ? '/en' : '') + '/blog', n = Math.ceil(list.length / PER_PAGE);
    for (let k = 1; k <= n; k++) {
      let html = tpl[lang + 'List'];
      const cards = list.slice((k - 1) * PER_PAGE, k * PER_PAGE).map(p => `<div class="col-12 col-md-6 col-lg-4 col-xxxl-3">${newsCard(p, lang)}</div>`).join('');
      html = replaceDiv(html, '<div class="col-10 offset-1"><div class="row">', `<div class="row">${cards}</div>`);
      html = html.replace(/<nav><ul class="pagination">[\s\S]*?<\/ul><\/nav>/, pagination(n, k, base));
      await write((k === 1 ? base : `${base}/pagina/${k}`) + '.html', finish(html, k === 1 ? base : `${base}/pagina/${k}`));
    }
  }

  // artigos novos do Drive, no modelo de artigo do site atual
  for (const lang of ['pt', 'en']) {
    const { html: t, slug } = tpl[lang + 'Post'];
    for (const p of fromFeed) {
      const f = p.feed;
      let html = t.split(slug).join(f.slug);
      html = setMeta(html, { title: f.title, desc: clip(f.meta || f.summary, 158) });
      html = replaceDiv(html, '<div class="post-image-container', f.imgs.map(im => `<picture class="post-image">${imgTag(im, '(min-width:768px) 50vw, 100vw', f.title)}</picture>`).join(''));
      html = html.replace(/<h2 class="post-title">[\s\S]*?<\/h2>/, `<h2 class="post-title">${esc(f.title)}</h2>`)
        .replace(/<div class="post-date">[\s\S]*?<\/div>/, `<div class="post-date"> ${esc(f.month)} </div>`);
      html = replaceDiv(html, '<div class="post-content">', postBody(f));
      html = replaceDiv(html, '<div class="news-slider">', blog(lang).filter(x => x !== p).slice(0, NEWS_ON_HOME).map(x => newsCard(x, lang, true)).join(''));
      await write(`${lang === 'en' ? '/en' : ''}${p.href}.html`, finish(html, `${lang === 'en' ? '/en' : ''}${p.href}`));
    }
  }

  const urls = pages.map(f => '/' + path.relative('site/pages', f).replace(/\.html$/, '').replace(/^index$/, ''))
    .filter(u => u !== '/404').concat(fromFeed.flatMap(p => [p.href, '/en' + p.href]));
  await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...new Set(urls)].map(u => `<url><loc>${SITE}${u}</loc></url>`).join('')}</urlset>`);
  await write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  await write('_headers', `/img/*\n  Cache-Control: public, max-age=31536000, immutable\n/storage/app/uploads/*\n  Cache-Control: public, max-age=31536000, immutable\n/storage/app/media/*\n  Cache-Control: public, max-age=3600\n/themes/*\n  Cache-Control: public, max-age=604800\n/assets/*\n  Cache-Control: public, max-age=604800\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`);
  // CSS: Bootstrap + tema reduzidos ao que as páginas e o JavaScript usam, e postos dentro de cada página
  // (evita 360 KB de CSS a bloquear a primeira pintura)
  const html = []; await (async function walkDist(d) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await walkDist(f); else if (f.endsWith('.html')) html.push(f); } })('dist');
  const purged = await new PurgeCSS().purge({
    content: [...html, 'dist/assets/theme.js'], css: ['dist/assets/bootstrap.min.css', 'dist/assets/theme.css'],
    safelist: { standard: ['loaded'], greedy: [/^slick/, /active/, /open/, /show/, /fixed/, /scroll/, /visible/, /hidden/, /loading/] },
  });
  const css = purged.map(r => r.css).join('').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '');
  for (const f of html) {
    const h = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, h.replace('<link rel="stylesheet" href="/assets/bootstrap.min.css"><link rel="stylesheet" href="/assets/theme.css">', () => `<style>${css}</style>`));
  }
  console.log(`CSS: ${Math.round(css.length / 1024)} KB dentro de cada página (era ${Math.round(((await fs.stat('dist/assets/bootstrap.min.css')).size + (await fs.stat('dist/assets/theme.css')).size) / 1024)} KB)`);
  console.log(`${pages.length} páginas, ${blog('pt').length} artigos no blog. Concluído em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
main().catch(e => { console.error(e); process.exit(1); });
