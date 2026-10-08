/**
 * Gera o site estático do Colégio Parque do Falcão.
 * Lê o feed do blog (Apps Script), descarrega e otimiza as fotos e escreve tudo em dist/.
 *
 * Variáveis de ambiente
 *   FEED_URL   URL da Aplicação Web do blog-feed-drive.gs (sem ela usa feed.sample.json)
 *   SITE_URL   endereço final do site (para canonical, sitemap e partilha)
 *   PHOTO_DIR  pasta local com fotos (só para testes, evita descarregar)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SITE = (process.env.SITE_URL || 'https://novo.parque-falcao.com').replace(/\/$/, '');
// Só conta se for um endereço https/http; qualquer outro valor (ou nada) usa feed.sample.json
const FEED_URL = /^https?:\/\//.test(process.env.FEED_URL || '') ? process.env.FEED_URL : undefined;
const PHOTO_DIR = process.env.PHOTO_DIR;
const FORM = 'https://forms.gle/5s2jkXaq54pBxrhg6';
const WIDTHS = [640, 1200, 1800];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = p => [p.summary, ...p.intro, ...p.sections.flatMap(s => [s.h, ...s.p]), p.closing].join(' ').split(/\s+/).length;
const mins = p => Math.max(1, Math.round(words(p) / 190)) + ' min de leitura';
const clip = (t, n) => t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;

/* ---------- dados ---------- */
async function loadFeed() {
  let data;
  if (FEED_URL) {
    const r = await fetch(FEED_URL, { redirect: 'follow' });
    if (!r.ok) throw new Error('Feed indisponível: ' + r.status);
    data = await r.json();
  } else data = JSON.parse(await fs.readFile('feed.sample.json', 'utf8'));
  return data.posts.filter(p => p.status === 'published').sort((a, b) => b.sort.localeCompare(a.sort));
}

/* ---------- fotos ---------- */
async function getBuffer(f) {
  if (PHOTO_DIR) { try { return await fs.readFile(path.join(PHOTO_DIR, f.name)); } catch {} }
  const cp = path.join('.cache', f.driveId + '.img');
  try { return await fs.readFile(cp); } catch {}
  const r = await fetch(`https://lh3.googleusercontent.com/d/${f.driveId}=w2000`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const b = Buffer.from(await r.arrayBuffer());
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
      out.push({ variants, w: ref.width, h: ref.height, alt: `${post.title} — foto ${i + 1}` });
    } catch (e) { console.warn(`  foto ignorada (${f.name}): ${e.message}`); }
  }
  post.imgs = out;
}
const imgTag = (im, sizes, eager) => {
  const mid = im.variants.find(v => v.width >= 1000) || im.variants[im.variants.length - 1];
  return `<img src="${mid.url}" srcset="${im.variants.map(v => `${v.url} ${v.width}w`).join(', ')}" sizes="${sizes}" width="${im.w}" height="${im.h}" alt="${esc(im.alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
};

/* ---------- mosaicos (capas sem foto) ---------- */
const PAL = ['#3D09DD', '#6D3CEA', '#25DBAE', '#EDB92F', '#F33340', '#28066A'];
function rng(seed) { let h = 1779033703 ^ seed.length; for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return () => { h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; }; }
function mosaic(seed, cols, rows) {
  const r = rng(seed), s = 100; let o = '';
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const a = Math.floor(r() * 6); let b = Math.floor(r() * 6); if (b === a) b = (b + 1) % 6;
    o += `<rect x="${x * s}" y="${y * s}" width="${s}" height="${s}" fill="${PAL[a]}"/><path d="M0 0H1A1 1 0 0 1 0 1Z" fill="${PAL[b]}" transform="translate(${x * s} ${y * s}) rotate(${Math.floor(r() * 4) * 90} 50 50) scale(${s})"/>`;
  }
  return `<svg viewBox="0 0 ${cols * s} ${rows * s}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${o}</svg>`;
}
const logo = () => { let o = ''; [['#3D09DD', 0], ['#25DBAE', 90], ['#EDB92F', 270], ['#F33340', 180]].forEach((v, i) => { o += `<path d="M0 0H1A1 1 0 0 1 0 1Z" fill="${v[0]}" transform="translate(${(i % 2) * 24} ${Math.floor(i / 2) * 24}) rotate(${v[1]} 12 12) scale(24)"/>`; }); return `<svg viewBox="0 0 48 48" aria-hidden="true">${o}</svg>`; };
function heroMosaic() {
  const r = rng('falcao-hero'), s = 100, n = 4; let o = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = Math.floor(r() * 6); let b = Math.floor(r() * 6); if (b === a) b = (b + 1) % 6;
    const rot = Math.floor(r() * 4) * 90, d = (x + y) * 90 + Math.floor(r() * 120);
    o += `<g transform="translate(${x * s} ${y * s})"><g class="pop" style="animation-delay:${d}ms"><rect width="${s}" height="${s}" fill="${PAL[a]}"/><path d="M0 0H1A1 1 0 0 1 0 1Z" fill="${PAL[b]}" transform="rotate(${rot} 50 50) scale(${s})"/></g></g>`;
  }
  return `<svg viewBox="0 0 ${n * s} ${n * s}" role="img" aria-label="Mosaico de quartos de círculo, inspirado no logótipo do colégio"><g style="clip-path:inset(0 round 0 140px 0 0)">${o}</g></svg>`;
}
const pillarIcon = i => { const c = [['#25DBAE', '#28066A'], ['#6D3CEA', '#EDB92F'], ['#F33340', '#3D09DD']][i]; return `<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true"><rect width="44" height="44" fill="${c[1]}"/><path d="M0 0H1A1 1 0 0 1 0 1Z" fill="${c[0]}" transform="rotate(${i * 90} 22 22) scale(44)"/></svg>`; };

/* ---------- estilos ---------- */
const EXTRA_CSS = `
@font-face{font-family:Jost;font-weight:400;font-style:normal;font-display:swap;src:url(/fonts/jost-400.woff2) format("woff2")}
@font-face{font-family:Jost;font-weight:500;font-style:normal;font-display:swap;src:url(/fonts/jost-500.woff2) format("woff2")}
@font-face{font-family:Jost;font-weight:600 700;font-style:normal;font-display:swap;src:url(/fonts/jost-600.woff2) format("woff2")}
.grid .card.dup{display:none}
.filtering .grid .card.dup{display:flex}
.filtering .feat{display:none}
.card[hidden]{display:none!important}
.slides{display:flex;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}
.slides::-webkit-scrollbar{display:none}
.slides img{flex:0 0 100%;width:100%;height:100%;object-fit:cover;scroll-snap-align:center}
.feat .cv img,.card .cv img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.feat .cv{position:relative}`;
const minify = c => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*([{};:,>])\s*/g, '$1').replace(/\s+/g, ' ').replace(/;}/g, '}');
let CSS = '';

/* ---------- layout ---------- */
const layout = ({ title, desc, url, body, image, ld, script }) => `<!DOCTYPE html>
<html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE}${url}">
<meta property="og:type" content="${ld ? 'article' : 'website'}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}${url}"><meta property="og:locale" content="pt_PT">${image ? `<meta property="og:image" content="${SITE}${image}">` : ''}
<link rel="preload" href="/fonts/jost-600.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/fonts/jost-400.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style>${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ''}</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="/" aria-label="Colégio Parque do Falcão — início"><span style="width:42px;height:42px;display:block">${logo()}</span><span>Colégio Parque do Falcão<small>Arrentela, Seixal</small></span></a>
<nav class="nav" aria-label="Principal"><a href="/">Início</a><a href="/blog/">Blog</a><a href="#contactos">Contactos</a><a class="btn" href="${FORM}" target="_blank" rel="noopener">Pré-inscrição</a></nav></div></header>
<main>${body}</main>
<footer class="foot" id="contactos"><div class="wrap"><div><p><strong>Colégio Parque do Falcão</strong></p><p>Creche, Pré-escolar e 1.º Ciclo</p><p>Arrentela, Seixal</p></div>
<div><p>Telefone: <a href="tel:+351212275035">+351 212 275 035</a></p><p>Instagram: @colegiofalcao</p><p><a href="${FORM}" target="_blank" rel="noopener">Ficha de pré-inscrição</a></p></div>
<div><p style="opacity:.75">© Colégio Parque do Falcão</p></div></div></footer>${script ? `<script>${script}</script>` : ''}</body></html>`;

/* ---------- páginas ---------- */
const coverEl = (p, sizes, mos) => p.imgs?.length ? imgTag(p.imgs[0], sizes) : mosaic(p.slug + (mos || ''), mos ? 5 : 4, 3);
const card = (p, dup) => `<a class="card${dup ? ' dup' : ''}" href="/blog/${p.slug}/" data-tags="${esc(p.tags.join('|'))}" data-text="${esc((p.title + ' ' + p.summary + ' ' + p.tags.join(' ')).toLowerCase())}"><div class="cv">${coverEl(p, '(min-width:980px) 380px, (min-width:620px) 50vw, 100vw')}</div><div class="bd"><div class="meta">${esc(p.month)} · ${mins(p)}</div><h3>${esc(p.title)}</h3><p>${esc(p.summary)}</p><div class="tags">${p.tags.slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></div></a>`;

function homePage(posts) {
  return layout({
    title: 'Colégio Parque do Falcão — Creche, Pré-escolar e 1.º Ciclo em Arrentela, Seixal',
    desc: 'Creche, Pré-escolar e 1.º Ciclo em Arrentela, Seixal. O mesmo projeto pedagógico acompanha cada criança do berço ao 4.º ano.', url: '/',
    body: `<section class="hero"><div class="wrap"><div><h1>Onde o crescer ganha asas</h1><p class="lead">Creche, Pré-escolar e 1.º Ciclo em Arrentela, Seixal. O mesmo projeto pedagógico acompanha cada criança do berço ao 4.º ano.</p><div class="cta"><a class="btn" href="${FORM}" target="_blank" rel="noopener">Pedir pré-inscrição</a><a class="btn alt" href="/blog/">Ler o blog</a></div></div><div class="heromos">${heroMosaic()}</div></div></section>
<section class="sec soft"><div class="wrap"><div class="sechead"><h2>Aprender a brincar, explorar e crescer</h2></div><div class="pillars">
<div class="pillar">${pillarIcon(0)}<h3>A natureza como sala de aula</h3><p>Horta escolar, projeto Eco-Escolas, aulas ao ar livre e visitas como a do Monte Selvagem.</p></div>
<div class="pillar">${pillarIcon(1)}<h3>Um só projeto, do berço ao 4.º ano</h3><p>Rotinas e aprendizagens que crescem com a criança, sem ruturas entre a creche, o pré-escolar e o 1.º Ciclo.</p></div>
<div class="pillar">${pillarIcon(2)}<h3>Famílias sempre por perto</h3><p>Festa da Família, intercâmbios entre turmas e momentos de partilha ao longo de todo o ano letivo.</p></div></div></div></section>
<section class="sec"><div class="wrap"><div class="sechead"><h2>O que se passou no Falcão</h2><a class="btn alt" href="/blog/">Ver todos os artigos</a></div><div class="grid">${posts.slice(0, 3).map(p => card(p)).join('')}</div></div></section>
<section class="sec"><div class="wrap"><div class="visit"><div><h2>Venha conhecer o colégio</h2><p>Preencha a ficha de pré-inscrição e entramos em contacto para marcar a visita.</p></div><a class="btn" href="${FORM}" target="_blank" rel="noopener">Pedir pré-inscrição</a></div></div></section>`
  });
}

const FILTER_JS = `(()=>{const q=document.getElementById('q'),pills=document.getElementById('pills'),cards=[...document.querySelectorAll('.grid .card')],cnt=document.getElementById('cnt'),root=document.getElementById('res');let tag='';
function run(){const t=q.value.trim().toLowerCase(),on=!!(tag||t);root.classList.toggle('filtering',on);let n=0;cards.forEach(c=>{const ok=(!tag||c.dataset.tags.split('|').includes(tag))&&(!t||c.dataset.text.includes(t));const vis=ok&&(on||!c.classList.contains('dup'));c.hidden=!vis;if(ok)n++;});
cnt.textContent=n+(n===1?' artigo':' artigos');document.getElementById('none').hidden=n>0;}
q.addEventListener('input',run);pills.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;tag=b.dataset.t;pills.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b));run();});})();`;

function blogPage(posts) {
  const m = {}; posts.forEach(p => p.tags.forEach(t => m[t] = (m[t] || 0) + 1));
  const top = Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt')).slice(0, 7).map(e => e[0]);
  const f = posts[0];
  return layout({
    title: 'Blog do Falcão | Colégio Parque do Falcão', desc: 'Um resumo de cada mês no Colégio Parque do Falcão, escrito pela equipa.', url: '/blog/',
    script: FILTER_JS,
    body: `<section class="bloghead"><div class="wrap"><h1>Blog do Falcão</h1><p>Um resumo de cada mês no colégio, escrito pela equipa.</p>
<div class="tools"><input class="search" id="q" type="search" placeholder="Pesquisar nos artigos" aria-label="Pesquisar nos artigos"><div class="pills" id="pills" role="group" aria-label="Filtrar por etiqueta"><button class="pill" type="button" data-t="" aria-pressed="true">Todos</button>${top.map(t => `<button class="pill" type="button" data-t="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')}</div></div>
<div id="res"><p class="count" id="cnt">${posts.length} artigos</p>
<a class="feat" href="/blog/${f.slug}/"><div class="cv">${f.imgs?.length ? imgTag(f.imgs[0], '(min-width:820px) 55vw, 100vw', true) : mosaic(f.slug, 5, 3)}</div><div class="bd"><div class="meta">${esc(f.month)} · ${mins(f)}</div><h2>${esc(f.title)}</h2><p>${esc(clip(f.summary, 260))}</p><div class="tags">${f.tags.slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></div></a>
<div class="grid">${posts.map((p, i) => card(p, i === 0)).join('')}</div><div class="empty" id="none" hidden>Nenhum artigo encontrado. Experimente outra palavra ou volte a “Todos”.</div></div></div></section>`
  });
}

const CAROUSEL_JS = `document.querySelectorAll('.stage').forEach(st=>{const sl=st.querySelector('.slides');if(!sl)return;const n=sl.children.length,c=st.querySelector('.cnt'),go=d=>sl.scrollBy({left:d*sl.clientWidth,behavior:'smooth'});st.querySelector('.pv').onclick=()=>go(-1);st.querySelector('.nx').onclick=()=>go(1);sl.addEventListener('scroll',()=>{c.textContent=(Math.round(sl.scrollLeft/sl.clientWidth)+1)+' / '+n},{passive:true});});`;

function postPage(p, i, posts) {
  const newer = posts[i - 1], older = posts[i + 1], n = p.imgs.length;
  const stage = n ? `<div class="stage"><div class="slides" tabindex="0" aria-label="Fotografias do artigo">${p.imgs.map((im, k) => imgTag(im, '(min-width:1180px) 1116px, 100vw', k === 0)).join('')}</div>${n > 1 ? `<div class="ctl"><button class="pv" type="button" aria-label="Foto anterior">‹</button><span class="cnt">1 / ${n}</span><button class="nx" type="button" aria-label="Foto seguinte">›</button></div>` : ''}</div>` : `<div class="stage">${mosaic(p.slug, 5, 3)}</div>`;
  const og = n ? p.imgs[0].variants.find(v => v.width >= 1000)?.url || p.imgs[0].variants.at(-1).url : null;
  const desc = clip(p.meta || p.summary, 158);
  const [mes, ano] = p.month.split(' ');
  return layout({
    title: `${p.title} | Colégio Parque do Falcão`, desc, url: `/blog/${p.slug}/`, image: og, script: n > 1 ? CAROUSEL_JS : '',
    ld: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, description: desc, inLanguage: 'pt-PT', datePublished: p.sort ? p.sort + '-28' : undefined, mainEntityOfPage: `${SITE}/blog/${p.slug}/`, image: og ? SITE + og : undefined, publisher: { '@type': 'EducationalOrganization', name: 'Colégio Parque do Falcão' } },
    body: `<div class="wrap"><nav class="crumbs" aria-label="Localização"><a href="/">Início</a> / <a href="/blog/">Blog</a> / ${esc(p.month)}</nav>
<header class="posthead"><div class="meta">${esc(p.month)} · ${mins(p)}</div><h1>${esc(p.title)}</h1><p class="lead">${esc(clip(p.summary, 230))}</p></header>${stage}
<div class="post"><article class="prose">${p.intro.map(t => `<p>${esc(t)}</p>`).join('')}${p.sections.map((s, k) => `<h2 id="s${k}">${esc(s.h)}</h2>${s.p.map(t => `<p>${esc(t)}</p>`).join('')}`).join('')}${p.closing ? `<p><strong>${esc(p.closing)}</strong></p>` : ''}</article>
<aside class="aside"><div><h3>Neste artigo</h3><ul class="toc">${p.sections.map((s, k) => `<li><a href="#s${k}">${esc(s.h)}</a></li>`).join('')}</ul></div>${p.tags.length ? `<div><h3>Etiquetas</h3><div class="tags" style="padding:0">${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>` : ''}</aside></div>
<div class="visit"><div><h2>Quer conhecer o projeto educativo de perto?</h2><p>Ligue para +351 212 275 035 ou preencha a ficha de pré-inscrição.</p></div><a class="btn" href="${FORM}" target="_blank" rel="noopener">Pedir pré-inscrição</a></div>
<nav class="pn" aria-label="Outros artigos">${older ? `<a href="/blog/${older.slug}/"><small>Mês anterior</small>${esc(older.title)}</a>` : '<span></span>'}${newer ? `<a href="/blog/${newer.slug}/"><small>Mês seguinte</small>${esc(newer.title)}</a>` : '<span></span>'}</nav></div>`
  });
}

/* ---------- construção ---------- */
const write = async (p, c) => { const f = path.join('dist', p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, c); };

async function main() {
  const t0 = Date.now();
  await fs.rm('dist', { recursive: true, force: true });
  CSS = minify((await fs.readFile('styles.css', 'utf8')).replace(/@import[^;]+;/g, '') + EXTRA_CSS);
  const posts = await loadFeed();
  console.log(`${posts.length} artigos`);
  for (const p of posts) { p.tags ||= []; p.intro ||= []; p.sections ||= []; p.closing ||= ''; console.log('·', p.month, `(${p.photos?.length || 0} fotos)`); await processPhotos(p); }

  for (const [w, f] of [[400, '400'], [500, '500'], [600, '600']]) await fs.mkdir('dist/fonts', { recursive: true }).then(() => fs.copyFile(`node_modules/@fontsource/jost/files/jost-latin-${w}-normal.woff2`, `dist/fonts/jost-${f}.woff2`));

  await write('index.html', homePage(posts));
  await write('blog/index.html', blogPage(posts));
  for (const [i, p] of posts.entries()) await write(`blog/${p.slug}/index.html`, postPage(p, i, posts));
  await write('404.html', layout({ title: 'Página não encontrada | Colégio Parque do Falcão', desc: 'Página não encontrada.', url: '/404.html', body: '<div class="wrap" style="padding:80px 0"><h1>Página não encontrada</h1><p style="margin:1em 0 1.4em" class="meta">O endereço pode ter mudado.</p><a class="btn" href="/blog/">Ir para o blog</a></div>' }));
  await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/blog/', ...posts.map(p => `/blog/${p.slug}/`)].map(u => `<url><loc>${SITE}${u}</loc></url>`).join('')}</urlset>`);
  await write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  await write('_headers', `/img/*\n  Cache-Control: public, max-age=31536000, immutable\n/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`);
  console.log(`Concluído em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
main().catch(e => { console.error(e); process.exit(1); });
