/**
 * Marca os textos e as fotos editáveis a partir do Google Drive e escreve site/content.json.
 * Correr depois de tools/import-site.mjs:  node tools/mark-content.mjs
 *
 * - Textos: cada texto simples do conteúdo da página (títulos, parágrafos, listas, botões, contactos)
 *   recebe data-t="<página>-tNN". Textos iguais na mesma página partilham o identificador.
 * - Fotos: cada <picture> (ou <img> solta) recebe data-f="<página>-fNN". A mesma foto noutras páginas
 *   (ex.: "Conheça as nossas instalações") fica com o identificador da primeira página onde aparece.
 * - Documentos: os PDFs ligados nas páginas (regulamentos, projetos, ementas).
 * Os atributos são inseridos no HTML original, sem o reescrever.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';

const PAGES = 'site/pages';
// páginas com Doc próprio (o blog tem o seu circuito); a versão inglesa entra no mesmo Doc
const DOCS = [
  ['index', 'en', 'Página inicial'],
  ['o-colegio', 'en/our-school', 'O Colégio'],
  ['o-colegio/as-nossas-instalacoes', 'en/our-school/our-facilities', 'As nossas instalações'],
  ['oferta-educativa/creche', 'en/educational-offering/nursery', 'Creche e Berçário'],
  ['oferta-educativa/pre-escolar', 'en/educational-offering/preschool', 'Pré-Escolar'],
  ['oferta-educativa/1-ciclo', 'en/educational-offering/primary', '1.º Ciclo'],
  ['oferta-educativa/atividades-servicos', 'en/educational-offering/activities-services', 'Serviços e Atividades'],
  ['contactos-e-horario', 'en/contactos-e-horario', 'Contactos e Horário'],
  ['politica-de-privacidade', 'en/privacy-policy', 'Política de Privacidade'],
  ['resolucao-de-conflitos', 'en/conflict-resolution', 'Resolução de Conflitos'],
];
const SIMPLE = /^(?:[^<]|<br\s*\/?>|<\/?(?:strong|b|em|i)>)*$/i;
const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'BR']);
const NEVER = new Set(['SCRIPT', 'STYLE', 'SVG', 'PICTURE', 'SELECT', 'OPTION', 'NOSCRIPT', 'TEMPLATE', 'IFRAME']);
const LABEL = { H1: 'Título', H2: 'Título', H3: 'Subtítulo', H4: 'Subtítulo', H5: 'Subtítulo', H6: 'Subtítulo', P: 'Parágrafo', LI: 'Item de lista', A: 'Ligação', LABEL: 'Botão' };

const key = f => f.replace(/\//g, '_').replace(/^index$/, 'inicio');
const plain = h => h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n').trim();
const inside = (e, test) => { for (let p = e.parentNode; p && p.tagName; p = p.parentNode) if (test(p)) return true; return false; };
const cls = (e, c) => (e.getAttribute && (e.getAttribute('class') || '').split(/\s+/).includes(c));

const photoIds = new Map();      // assinatura (lista de imagens) -> id
const photos = {};               // id -> { page, label, variants }
const docsSeen = new Map();      // caminho do PDF -> nome amigável

async function markPage(file, pageKey, docTitle) {
  const f = path.join(PAGES, file + '.html');
  let html = await fs.readFile(f, 'utf8');
  html = html.replace(/ data-[tf]="[^"]*"/g, '');                 // volta a marcar do zero
  const root = parse(html, { comment: true });
  const main = root.querySelector('main');
  const inserts = [];                                              // [posição, texto a inserir]
  const at = (e, attr) => inserts.push([e.range[0] + 1 + e.rawTagName.length, ` ${attr}`]);

  // textos
  const texts = [], byText = new Map();
  for (const e of main ? main.querySelectorAll('*') : []) {
    if (INLINE.has(e.tagName) || NEVER.has(e.tagName) || inside(e, p => NEVER.has(p.tagName) || cls(p, 'news-slider'))) continue;
    const h = e.innerHTML.trim();
    if (!SIMPLE.test(h)) continue;
    const t = plain(h);
    if (t.length < 2) continue;
    let id = byText.get(t);
    if (!id) {
      id = `${pageKey}-t${String(texts.length + 1).padStart(2, '0')}`;
      byText.set(t, id);
      texts.push({ id, label: cls(e, 'btn-txt') ? 'Botão' : LABEL[e.tagName] || 'Texto', text: t });
    }
    at(e, `data-t="${id}"`);
  }

  // fotos (em toda a página, menos cabeçalho e rodapé; as notícias do blog são geradas)
  const pagePhotos = [];
  for (const e of root.querySelectorAll('picture, img')) {
    if (e.tagName === 'IMG' && inside(e, p => p.tagName === 'PICTURE')) continue;
    if (inside(e, p => ['HEADER', 'FOOTER'].includes(p.tagName) || cls(p, 'news-slider'))) continue;
    const urls = [...new Set((e.toString().match(/\/img\/[0-9a-f]{20}\.webp/g) || []))];
    if (!urls.length) continue;
    const sig = urls.slice().sort().join('|');
    let id = photoIds.get(sig);
    if (!id) {
      id = `${pageKey}-f${String(Object.keys(photos).filter(k => k.startsWith(pageKey + '-f')).length + 1).padStart(2, '0')}`;
      photoIds.set(sig, id);
      const img = e.tagName === 'IMG' ? e : e.querySelector('img');
      photos[id] = { page: docTitle, alt: img?.getAttribute('alt') || '', variants: urls };
      pagePhotos.push(id);
    }
    at(e, `data-f="${id}"`);
  }

  // documentos PDF
  for (const [, href] of html.matchAll(/href="(\/storage\/app\/media\/[^"]+\.pdf)"/g)) {
    const p = decodeURI(href);
    if (!docsSeen.has(p)) docsSeen.set(p, path.basename(p).replace(/\.docx\.pdf$/, '.pdf').replace(/[_]+/g, ' ')
      .replace(/ (Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez|v\d)(?=\.pdf$)/i, '').replace(/\s+\.pdf$/, '.pdf'));
  }

  for (const [pos, s] of inserts.sort((a, b) => b[0] - a[0])) html = html.slice(0, pos) + s + html.slice(pos);
  await fs.writeFile(f, html);
  return { texts, photos: pagePhotos, title: (root.querySelector('title')?.text || '').trim() };
}

const content = { docs: [], photos, documents: [] };
for (const [pt, en, title] of DOCS) {
  const a = await markPage(pt, key(pt), title);
  const b = await markPage(en, key(en), title);
  content.docs.push({ title, pt: { url: pt === 'index' ? '/' : '/' + pt, texts: a.texts }, en: { url: '/' + en, texts: b.texts } });
  console.log(title.padEnd(26), `textos PT ${a.texts.length}, EN ${b.texts.length}; fotos ${a.photos.length + b.photos.length}`);
}
// só os PDFs que existem (o site atual tem um link partido para uma versão antiga de um regulamento)
const exists = async p => fs.access(path.join('site/files', p)).then(() => true, () => false);
content.documents = [];
for (const [url, name] of docsSeen) if (await exists(url)) content.documents.push({ url, name });
await fs.writeFile('site/content.json', JSON.stringify(content, null, 1));
console.log(`${Object.keys(photos).length} fotos, ${content.documents.length} documentos -> site/content.json`);
