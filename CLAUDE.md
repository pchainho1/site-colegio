# Contexto do projeto (para o Claude Code)

Paulo Chainho, administrador Google Workspace do Colégio Parque do Falcão (Arrentela, Seixal), está a
reconstruir o site colegio-falcao.com. Responder sempre em português de Portugal.

## Objetivo
Nova versão do site com blog alimentado por texto e fotos de uma pasta partilhada do Google Drive.
Requisito firme: desempenho igual ou melhor ao do site atual (medir ambos no PageSpeed Insights).
Fotos do blog numa pasta privada do Drive; o Apps Script entrega-as ao build (nunca públicas).

## Arquitetura (decidida)
Google Docs (privados) -> Apps Script (`apps-script/blog-feed-drive.gs`, Aplicação Web protegida por chave FEED_KEY)
entrega o feed JSON e as fotos (`?photo=<id>`, só fotos de artigos publicados)
-> `build.mjs` descarrega e otimiza fotos (WebP 640/1200/1800), gera HTML estático em `dist/`
-> Cloudflare (Workers Builds + static assets, ver `wrangler.jsonc`) -> subdomínio novo.parque-falcao.com
(o domínio colegio-falcao.com está noutra conta Cloudflare, gerida pelo atual alojamento do site; parque-falcao.com está na conta do Paulo).
O visitante nunca fala com o Drive nem com o Apps Script.

## Site com o aspeto do site atual (decidido)
O site reproduz o aspeto do www.colegio-falcao.com (feito pela Adhesive, CMS October). `tools/import-site.mjs`
(correr à mão com `NODE_USE_ENV_PROXY=1 node tools/import-site.mjs`) copia para `site/`: páginas PT e EN limpas
(sem GTM/Analytics), tema (`site/assets/theme.css|js`), ícones/fontes/PDFs (`site/files`, mesmos caminhos) e as
imagens WebP com os cortes de cada ecrã (`site/img`). `site/posts.json` tem os cartões dos 38 artigos antigos.
`build.mjs`: serve as páginas com Bootstrap 5.1.0 e jQuery 3.6.0 (fixos, de node_modules), CSS reduzido com PurgeCSS e
posto dentro de cada página, primeira imagem sem carregamento diferido, página visível sem esperar pelo JS.
Gera a listagem do blog (`/blog`, `/blog/pagina/N`, também `/en/...`) e as notícias da página inicial.
Artigos do Drive só entram depois de `ARCHIVE_UNTIL` (2026-06), no modelo de artigo do site atual, em `/blog/default/<slug>`.
Mesmos endereços do site atual (ex.: `/o-colegio`), por isso não são precisos redirecionamentos ao trocar o domínio.
Mapa dos contactos: a chave do Google Maps só aceita colegio-falcao.com (no domínio novo dá erro até se trocar o domínio
ou acrescentar o domínio à chave).

## Ids do Drive
- Pasta dos Docs do blog (privada): 1kG_XezakU4YEccvqDKXMqmpVEzPRMIBa
- Pasta de fotos de maio (privada): 1tIHe0VxAKeSyDGdBf3eMGQQ4yM56kze1
- Pasta de fotos aprovadas: 1aHiZGw6hoRXLQu_X8fSuX080WB4oXdHx ("Blog - fotos aprovadas", no drive pessoal do Paulo).
  Deve ser PRIVADA (tirar da pasta "público", que é partilhada com qualquer pessoa com o link). NÃO usar a unidade partilhada:
  tem muitos membros, incluindo uma empresa externa com conta interna. Só copiar para lá fotos com autorização de imagem.
  Uma subpasta por artigo, com o mês no início do nome ("2026-05 Maio"; já criadas de 2025-11 a 2026-06).
  Todas as fotos da pasta do mês entram no artigo (por ordem do nome); as nomeadas no Doc vêm primeiro e a capa é a
  do Doc ou, sem ela, a primeira por nome (ex.: "00-..."). Fotos soltas na raiz só entram se o Doc as nomear.

## Convenções dos Docs (confirmadas nos 20 Docs existentes -> 8 artigos, nov 2025 a jun 2026)
- Um artigo por mês; título do Doc com mês e ano. Vence a versão editada por último.
- Ignorar títulos com "RASCUNHO" e Docs quase vazios (< 1500 caracteres).
- Nunca publicar secções de notas internas ("Nota para a equipa", "Notas editoriais").
- Artigos com nota sobre autorização de imagem ficam "em espera" (status hold).
- Estruturas de Doc variam (3 modelos); o parser em `parseDoc_` é tolerante. Emojis nos títulos são removidos.
- Só maio tem fotos reais no Drive; nos outros meses os Docs só nomeiam ficheiros que não estão na pasta.

## Estado
Testado: `build.mjs` com `PHOTO_DIR` (fotos de teste) e feed de exemplo; páginas, filtros e pesquisa no browser.
NÃO testado: o .gs no Apps Script, descarga de fotos reais via lh3.googleusercontent.com, deploy na Cloudflare.
`FEED_URL` é opcional: sem URL https válido usa `feed.sample.json`.

## Pendente
1. Repositório GitHub com estes ficheiros na raiz; ligar à Cloudflare (build: `npm ci && node build.mjs`, deploy: `npx wrangler deploy`, NODE_VERSION=20).
2. Implementar o .gs como Aplicação Web (executar como Paulo, acesso a qualquer pessoa; criarChave() uma vez) e pôr na Cloudflare
   FEED_URL (URL /exec) e FEED_KEY (secret). O código do .gs é copiado à mão para o editor (decisão: sem clasp, para não guardar
   credenciais da conta de administrador do Paulo).
3. Tornar privada a pasta de fotos aprovadas e confirmar autorizações de imagem antes de copiar fotos para lá.
4. Deploy hook (Cloudflare: Settings > Builds > Deploy Hooks, ramo main) -> BUILD_HOOK_URL nas Propriedades do script
   -> executar `instalarAcionador()` uma vez (acionador de 15 min para `checkAndTriggerBuild`, só reconstrói se algo mudou).
5. Redirecionamentos: já não são precisos (os endereços são os mesmos do site atual).
6. Medir desempenho (PageSpeed) do site atual e do novo.
7. Ainda não feito: assistente "Pergunte ao Falcão". Google Analytics foi retirado (decidir se volta, com aviso de cookies).

## Marca
Cores: #28066A (títulos), #3D09DD (botões), #6D3CEA, #25DBAE, #EDB92F, #F33340. Fonte da marca: Brown Std (licença web por
confirmar com o estúdio); em uso: Jost. Possível erro no guia: Electric Green e Electric Violet com o mesmo hex.
Logótipo: mosaico de quartos de círculo, usado nas capas sem foto.

## Como testar
    npm install
    PHOTO_DIR=/caminho/fotos node build.mjs   # ou sem PHOTO_DIR para descarregar do Drive
    python3 -m http.server -d dist
