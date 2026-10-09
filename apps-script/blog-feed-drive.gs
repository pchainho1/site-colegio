/**
 * Blog do Colégio Parque do Falcão: feed JSON a partir da pasta partilhada do Drive.
 *
 * Instalação
 * 1. Crie um projeto em script.google.com (na conta do colégio) e cole este ficheiro.
 * 2. Execute testFeed() uma vez e aceite as permissões (Drive e Documentos).
 * 3. Execute criarChave() uma vez: guarda a chave FEED_KEY (Propriedades do script) e mostra-a no registo.
 * 4. Implementar > Nova implementação > Aplicação Web.
 *    Executar como: eu. Quem tem acesso: qualquer pessoa. Sem a chave não se obtém nada; com ela, só artigos
 *    publicados e as fotos desses artigos. A pasta de fotos aprovadas pode (e deve) ser privada.
 * 5. Na Cloudflare: FEED_URL = URL da implementação (termina em /exec) e FEED_KEY = a chave (como secret).
 *
 * Convenções que o script assume (todas confirmadas nos Docs atuais)
 * - Um artigo por mês; o título do Doc inclui mês e ano (ex.: "Blog Maio 2026 ...").
 * - Se houver várias versões do mesmo mês, vence a editada por último.
 * - Títulos com "RASCUNHO" e Docs quase vazios são ignorados.
 * - Secções de notas internas ("Nota para a equipa", "Notas editoriais") nunca saem no feed.
 */

const CONFIG = {
  FOLDER_ID: '1kG_XezakU4YEccvqDKXMqmpVEzPRMIBa',   // Docs (privada)
  PHOTOS_FOLDER_ID: '1aHiZGw6hoRXLQu_X8fSuX080WB4oXdHx', // só fotos aprovadas (pasta privada, uma subpasta por mês)
  MIN_CHARS: 1500,            // abaixo disto o Doc conta como vazio
  CACHE_SECONDS: 600,
  HOLD_IF_CONSENT_NOTE: true  // artigos com nota sobre autorização de imagem ficam "em espera"
};

const MESES = ['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const IMG_RE = /[\w\-]+\.(?:jpe?g|png|webp)/gi;

function doGet(e) {
  const q = (e && e.parameter) || {};
  // Sem a chave certa não se entrega nada (a chave está em Propriedades do script > FEED_KEY e na Cloudflare)
  const key = PropertiesService.getScriptProperties().getProperty('FEED_KEY');
  if (!key || q.key !== key) return json_({ error: 'acesso negado' });
  const body = feedJson_(q.refresh === '1');
  if (q.photo) return json_(photo_(q.photo, JSON.parse(body)));
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function feedJson_(force) {
  const cache = CacheService.getScriptCache();
  let body = force ? null : cache.get('feed');
  if (!body) {
    body = JSON.stringify(publicView_(buildFeed_(), false));
    try { cache.put('feed', body, CONFIG.CACHE_SECONDS); } catch (err) { /* feed grande demais para a cache */ }
  }
  return body;
}

// Só entrega fotos que fazem parte de artigos publicados; nunca outro ficheiro do Drive.
function photo_(id, feed) {
  const ok = feed.posts.some(p => (p.photos || []).some(f => f.driveId === id));
  if (!ok) return { error: 'foto não publicada' };
  const blob = DriveApp.getFileById(id).getBlob();
  return { name: blob.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// O feed público não leva avisos internos nem links para os Docs.
function publicView_(feed, debug) {
  if (debug) return feed;
  return { generated: feed.generated, posts: feed.posts.filter(p => p.status === 'published').map(p => {
    delete p.warnings; delete p.editUrl; delete p.updated; return p; }) };
}

// Executar uma vez: cria a chave FEED_KEY e mostra-a no registo para copiar para a Cloudflare.
function criarChave() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('FEED_KEY');
  if (!key) { key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); props.setProperty('FEED_KEY', key); }
  Logger.log('FEED_KEY: %s', key);
}

function testFeed() {
  const feed = buildFeed_();
  Logger.log('%s artigos, %s ignorados', feed.posts.length, feed.ignored.length);
  feed.posts.forEach(p => {
    Logger.log('%s | %s | %s', p.month, p.status === 'hold' ? 'EM ESPERA (não publicado)' : 'publicado', p.title);
    p.warnings.forEach(w => Logger.log('    aviso: %s', w));
  });
  feed.ignored.forEach(d => Logger.log('ignorado (%s): %s', d.why, d.name));
}

/* ---------- 1. escolher os Docs ---------- */
function buildFeed_() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const images = indexImages_(DriveApp.getFolderById(CONFIG.PHOTOS_FOLDER_ID));
  const groups = {}, ignored = [];

  const it = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  while (it.hasNext()) {
    const f = it.next(), name = f.getName();
    if (/rascunho/i.test(name)) { ignored.push({ name, why: 'rascunho' }); continue; }
    const key = monthKey_(name) || f.getId();
    (groups[key] = groups[key] || []).push(f);
  }

  const posts = [];
  Object.keys(groups).forEach(key => {
    const docs = groups[key].sort((a, b) => b.getLastUpdated() - a.getLastUpdated());
    let chosen = null;
    docs.forEach(f => {
      const len = DocumentApp.openById(f.getId()).getBody().getText().length;
      if (!chosen && len >= CONFIG.MIN_CHARS) chosen = f;
      else ignored.push({ name: f.getName(), why: len < CONFIG.MIN_CHARS ? 'vazio' : 'versão mais antiga' });
    });
    if (chosen) posts.push(parseDoc_(chosen, key, images));
  });

  posts.sort((a, b) => b.sort.localeCompare(a.sort));
  return { generated: new Date().toISOString(), posts, ignored };
}

function monthKey_(title) {
  const t = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const m = t.match(/(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(?:de\s*)?(20\d\d)/);
  return m ? m[2] + '-' + ('0' + (MESES.indexOf(m[1]) + 1)).slice(-2) : null;
}

/* ---------- 2. ler um Doc ---------- */
function parseDoc_(file, key, images) {
  const paras = DocumentApp.openById(file.getId()).getBody().getParagraphs();
  const post = {
    id: file.getId(), sort: key.length === 7 ? key : '0000-00', month: monthLabel_(key), docTitle: file.getName(),
    editUrl: file.getUrl(), updated: file.getLastUpdated().toISOString(),
    title: '', slug: '', summary: '', meta: '', cover: '', tags: [], intro: [], sections: [],
    closing: '', photos: [], warnings: [], status: 'published'
  };
  let mode = 'start', cur = null;

  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const raw = p.getText().replace(/\u00a0/g, ' ').trim();
    if (!raw || /^[=\-\s]+$/.test(raw)) continue;
    const text = stripEmoji_(raw);
    const label = labelOf_(text);

    if (label) { mode = label; if (label !== 'title' && label !== 'summary' && label !== 'cover') continue; }
    if (mode === 'drop') {
      if (/autoriza[cç][oõ]es? de imagem/i.test(text) && CONFIG.HOLD_IF_CONSENT_NOTE) post.status = 'hold';
      continue;
    }
    // notas internas escondidas em qualquer secção
    if (/autoriza[cç][oõ]es? de imagem/i.test(text)) { post.status = CONFIG.HOLD_IF_CONSENT_NOTE ? 'hold' : post.status; continue; }

    switch (mode) {
      case 'summary': {
        const t = text.replace(/^resumo[^:]*:\s*/i, '');
        if (!label && t.length > 60) post.summary += (post.summary ? ' ' : '') + t;
        const img = text.match(IMG_RE); if (img && !post.cover) post.cover = img[0];
        break;
      }
      case 'cover': { const img = text.match(IMG_RE); if (img && !post.cover) post.cover = img[0]; break; }
      case 'title': if (!label && !post.title) post.title = text; break;
      case 'slug': if (!label) post.slug = text; break;
      case 'meta': if (!label) post.meta = text; break;
      case 'tags': if (!label) post.tags = post.tags.concat(text.split(/[,;|.]/).map(normTag_).filter(Boolean)); break;
      case 'photos': (text.match(IMG_RE) || []).forEach(n => post.photos.push(n)); break;
      case 'closing': if (!label) post.closing += (post.closing ? ' ' : '') + text; break;
      case 'body': {
        if (label) break;
        const next = paras[i + 1] ? paras[i + 1].getText().trim() : '';
        if (isHeading_(p, text, next)) { cur = { h: sentenceCase_(text), p: [] }; post.sections.push(cur); }
        else if (cur) cur.p.push(text); else post.intro.push(text);
      }
    }
  }

  if (!post.title) { post.title = file.getName(); post.warnings.push('Sem título no Doc: usado o nome do ficheiro'); }
  if (!post.slug) { post.slug = slugify_(post.title); post.warnings.push('Sem slug no Doc: gerado a partir do título'); }
  if (!post.tags.length) post.warnings.push('Sem etiquetas');
  if (!post.summary) post.summary = (post.intro[0] || '').slice(0, 300);
  if (post.status === 'hold') post.warnings.push('Nota sobre autorização de imagem: confirmar antes de publicar');

  // fotos: todas as da pasta do mês do artigo; as nomeadas no Doc vêm primeiro (a capa à cabeça)
  const local = images.byMonth[key] || {};
  const pick = n => local[n.toLowerCase()] || images.all[n.toLowerCase()];
  const resolved = [], missing = [];
  const add = f => { if (!resolved.some(r => r.driveId === f.id)) resolved.push({ name: f.name, driveId: f.id }); };
  [post.cover].concat(post.photos).filter(Boolean).forEach(n => {
    const f = pick(n);
    if (f) add(f); else if (missing.indexOf(n) < 0) missing.push(n);
  });
  Object.keys(local).sort().forEach(k => add(local[k]));
  post.cover = post.cover && pick(post.cover) ? pick(post.cover).name : (resolved[0] ? resolved[0].name : '');
  post.photos = resolved;
  if (missing.length && !Object.keys(local).length) post.warnings.push(missing.length + ' foto(s) referida(s) no Doc não estão na pasta pública de fotos');
  if (!resolved.length) post.warnings.push('Sem fotos: a pasta deste mês em "Blog - fotos aprovadas" está vazia');
  delete post.docTitle;
  return post;
}

/* ---------- 3. auxiliares ---------- */
function labelOf_(text) {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^[^a-z]+/, '').replace(/[:\s]+$/, '');
  if (/^(nota (para a equipa|editoriais?)|tema escolhido)/.test(t)) return 'drop';
  if (/^resumo/.test(t)) return 'summary';
  if (/^foto (para mosaico|recomendada)/.test(t)) return 'cover';
  if (/^titulo( do blog| sugerido)?$/.test(t)) return 'title';
  if (/^(texto do blog|corpo do texto)$/.test(t)) return 'body';
  if (/^fecho/.test(t)) return 'closing';
  if (/^(etiquetas|tags)$/.test(t)) return 'tags';
  if (/^(fotos para carrossel|carrossel de fotos|fotos selecionadas)/.test(t)) return 'photos';
  if (/^slug/.test(t)) return 'slug';
  if (/^(excerto|meta description)/.test(t)) return 'meta';
  return null;
}

function isHeading_(p, text, next) {
  const h = p.getHeading();
  if (h && h !== DocumentApp.ParagraphHeading.NORMAL) return true;
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length > 6 && text === text.toUpperCase() && text.length < 90) return true;
  return text.length < 80 && !/[.!?:]$/.test(text) && next.length > 100;
}

function sentenceCase_(t) {
  if (t !== t.toUpperCase()) return t;
  const s = t.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function stripEmoji_(t) { return t.replace(/^[^\p{L}\p{N}“"(\[]+/u, '').trim(); }

function normTag_(t) {
  t = t.trim().replace(/^1\.?º\s*ciclo$/i, '1.º Ciclo').replace(/^pr[eé]-escolar$/i, 'Pré-escolar');
  return t.length > 1 ? t : '';
}

function monthLabel_(key) {
  if (key.length !== 7) return '';
  const nomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  return nomes[parseInt(key.slice(5), 10) - 1] + ' ' + key.slice(0, 4);
}

function slugify_(t) {
  return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// Uma subpasta por artigo, com o mês no nome ("2026-05 Maio" ou "Maio 2026").
// Todas as fotos da pasta do mês entram no artigo; as soltas na raiz só entram se o Doc as nomear.
function indexImages_(folder, index, key) {
  index = index || { all: {}, byMonth: {} };
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (!/^image\//.test(f.getMimeType())) continue;
    const img = { name: f.getName(), id: f.getId() }, lower = img.name.toLowerCase();
    if (key) (index.byMonth[key] = index.byMonth[key] || {})[lower] = img;
    if (!index.all[lower]) index.all[lower] = img;
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) { const sub = subs.next(); indexImages_(sub, index, folderKey_(sub.getName()) || key); }
  return index;
}

function folderKey_(name) {
  const m = name.match(/^(20\d\d)-(0[1-9]|1[0-2])\b/);
  return m ? m[1] + '-' + m[2] : monthKey_(name);
}

/* ---------- 4. reconstruir o site quando algo muda ---------- */
/**
 * Guarde o endereço do "deploy hook" da hospedagem em Propriedades do script (BUILD_HOOK_URL).
 * Crie um acionador por tempo (a cada 15 minutos) para esta função.
 * Só dispara a reconstrução se os artigos ou a lista de fotos tiverem mudado.
 */
function checkAndTriggerBuild() {
  const props = PropertiesService.getScriptProperties();
  const hook = props.getProperty('BUILD_HOOK_URL');
  if (!hook) return;
  const posts = publicView_(buildFeed_(), false).posts;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(posts), Utilities.Charset.UTF_8);
  const hash = Utilities.base64Encode(digest);
  if (hash === props.getProperty('LAST_BUILD_HASH')) return;
  const res = UrlFetchApp.fetch(hook, { method: 'post', muteHttpExceptions: true });
  if (res.getResponseCode() < 300) props.setProperty('LAST_BUILD_HASH', hash);
  else Logger.log('Falha ao disparar a reconstrução: ' + res.getResponseCode());
}
