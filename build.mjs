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
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

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
const finish = html => html.replace('<!--ASSETS-->', ASSETS).replace('<!--EXTRA_STYLES-->', '').split(OLD_SITE).join(SITE)
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
  for (const f of pages) {
    const url = '/' + path.relative('site/pages', f).replace(/\.html$/, '').replace(/^index$/, '');
    let html = await fs.readFile(f, 'utf8');
    const lang = url.startsWith('/en') ? 'en' : 'pt';
    if (url === '/' || url === '/en') html = replaceDiv(html, '<div class="news-slider">', blog(lang).slice(0, NEWS_ON_HOME).map(p => newsCard(p, lang, true)).join(''));
    if (/^(\/en)?\/blog$/.test(url)) { tpl[lang + 'List'] = html; continue; }        // a listagem é gerada abaixo
    if (/\/blog\/default\//.test(url) && !tpl[lang + 'Post']) tpl[lang + 'Post'] = { html, slug: url.split('/').pop() };
    await write((url === '/' ? '/index' : url) + '.html', finish(html));
  }

  // listagem do blog, paginada como no site atual (/blog, /blog/pagina/2, ...)
  for (const lang of ['pt', 'en']) {
    const list = blog(lang), base = (lang === 'en' ? '/en' : '') + '/blog', n = Math.ceil(list.length / PER_PAGE);
    for (let k = 1; k <= n; k++) {
      let html = tpl[lang + 'List'];
      const cards = list.slice((k - 1) * PER_PAGE, k * PER_PAGE).map(p => `<div class="col-12 col-md-6 col-lg-4 col-xxxl-3">${newsCard(p, lang)}</div>`).join('');
      html = replaceDiv(html, '<div class="col-10 offset-1"><div class="row">', `<div class="row">${cards}</div>`);
      html = html.replace(/<nav><ul class="pagination">[\s\S]*?<\/ul><\/nav>/, pagination(n, k, base));
      await write((k === 1 ? base : `${base}/pagina/${k}`) + '.html', finish(html));
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
      await write(`${lang === 'en' ? '/en' : ''}${p.href}.html`, finish(html));
    }
  }

  const urls = pages.map(f => '/' + path.relative('site/pages', f).replace(/\.html$/, '').replace(/^index$/, ''))
    .filter(u => u !== '/404').concat(fromFeed.flatMap(p => [p.href, '/en' + p.href]));
  await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...new Set(urls)].map(u => `<url><loc>${SITE}${u}</loc></url>`).join('')}</urlset>`);
  await write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  await write('_headers', `/img/*\n  Cache-Control: public, max-age=31536000, immutable\n/storage/*\n  Cache-Control: public, max-age=31536000, immutable\n/themes/*\n  Cache-Control: public, max-age=604800\n/assets/*\n  Cache-Control: public, max-age=604800\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`);
  console.log(`${pages.length} páginas, ${blog('pt').length} artigos no blog. Concluído em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
main().catch(e => { console.error(e); process.exit(1); });
