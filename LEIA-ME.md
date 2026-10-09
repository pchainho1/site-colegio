# Site do Colégio Parque do Falcão (estático)

A cada construção, `build.mjs` lê o feed do blog, descarrega as fotos da pasta pública do Drive,
converte-as para WebP em 3 tamanhos e escreve páginas HTML prontas em `dist/`.
O visitante nunca fala com o Drive nem com o Apps Script.

## Experimentar no computador
    npm install
    node build.mjs            # usa feed.sample.json
    npx serve dist            # ou: python3 -m http.server -d dist

## Publicar na Cloudflare
1. Ponha esta pasta (com o `wrangler.jsonc`) na raiz de um repositório do GitHub.
2. Cloudflare > Workers & Pages > Create application > importar o repositório (Import a repository).
3. Comando de construção (Build command): `npm ci && node build.mjs`
   Comando de implementação (Deploy command): `npx wrangler deploy`
   A pasta `dist` já está indicada no `wrangler.jsonc`, por isso não há campo "output directory".
4. Variáveis de ambiente (Build variables):
   - `NODE_VERSION` = 20
   - `FEED_URL` = URL da Aplicação Web do blog-feed-drive.gs (termina em `/exec`)
   - `FEED_KEY` = chave criada por `criarChave()` no Apps Script (guardar como *secret*)
   - `SITE_URL` = endereço final, ex.: https://novo.parque-falcao.com
5. Domínio: no projeto, Settings > Domains & Routes > Add > Custom domain.
6. Atualização automática: Settings > Builds > Deploy Hooks > criar hook para o ramo `main`; guardar o endereço no
   Apps Script como `BUILD_HOOK_URL` (Propriedades do script) e executar `instalarAcionador()` uma vez.

## Notas
- Fotos: a primeira construção descarrega tudo (cerca de 10 s por 20 fotos); as seguintes reutilizam a cache da hospedagem quando existir.
- O `Cache-Control` de imagens e fontes está em `_headers` (1 ano, imutável).
- Endereços dos artigos: `/blog/<slug>/`. Se o site atual já tiver endereços de blog, é preciso criar redirecionamentos (ficheiro `_redirects`).
