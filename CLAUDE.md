# Contexto do projeto (para o Claude Code)

Paulo Chainho, administrador Google Workspace do Colégio Parque do Falcão (Arrentela, Seixal), está a
reconstruir o site colegio-falcao.com. Responder sempre em português de Portugal.

## Objetivo
Nova versão do site com blog alimentado por texto e fotos de uma pasta partilhada do Google Drive.
Requisito firme: desempenho igual ou melhor ao do site atual (medir ambos no PageSpeed Insights).
Fotos do blog podem estar numa pasta pública do Drive.

## Arquitetura (decidida)
Google Docs (privados) -> Apps Script (`apps-script/blog-feed-drive.gs`) publica feed JSON
-> `build.mjs` descarrega e otimiza fotos (WebP 640/1200/1800), gera HTML estático em `dist/`
-> Cloudflare (Workers Builds + static assets, ver `wrangler.jsonc`) -> subdomínio novo.parque-falcao.com
(o domínio colegio-falcao.com está noutra conta Cloudflare, gerida pelo atual alojamento do site; parque-falcao.com está na conta do Paulo).
O visitante nunca fala com o Drive nem com o Apps Script.

## Ids do Drive
- Pasta dos Docs do blog (privada): 1kG_XezakU4YEccvqDKXMqmpVEzPRMIBa
- Pasta de fotos de maio (privada): 1tIHe0VxAKeSyDGdBf3eMGQQ4yM56kze1
- Pasta pública de fotos aprovadas: 1aHiZGw6hoRXLQu_X8fSuX080WB4oXdHx ("Blog - fotos aprovadas", dentro da pasta "público"
  do drive pessoal do Paulo, já partilhada com qualquer pessoa com o link). NÃO usar a unidade partilhada:
  tem muitos membros, incluindo uma empresa externa com conta interna. Só copiar para lá fotos com autorização de imagem.
  Uma subpasta por artigo, com o mês no início do nome ("2026-05 Maio"; já criadas de 2025-11 a 2026-06).
  O .gs procura as fotos de cada artigo primeiro na pasta do seu mês; fotos soltas na raiz servem a todos.

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
2. Implementar o .gs como Aplicação Web (executar como Paulo, acesso a qualquer pessoa) e pôr o URL (+ ?refresh=1) em FEED_URL.
3. Criar a pasta pública de fotos (o administrador tem de permitir partilha externa) e confirmar autorizações de imagem antes de mover fotos para lá.
4. Deploy hook + BUILD_HOOK_URL no Apps Script + acionador de 15 min para `checkAndTriggerBuild`.
5. Redirecionamentos dos endereços do site atual (`_redirects`): pedir a Paulo a lista de URLs atuais do blog.
6. Medir desempenho (PageSpeed) do site atual e do novo.
7. Ainda não feito: PT/EN, assistente "Pergunte ao Falcão", restantes páginas do site.

## Marca
Cores: #28066A (títulos), #3D09DD (botões), #6D3CEA, #25DBAE, #EDB92F, #F33340. Fonte da marca: Brown Std (licença web por
confirmar com o estúdio); em uso: Jost. Possível erro no guia: Electric Green e Electric Violet com o mesmo hex.
Logótipo: mosaico de quartos de círculo, usado nas capas sem foto.

## Como testar
    npm install
    PHOTO_DIR=/caminho/fotos node build.mjs   # ou sem PHOTO_DIR para descarregar do Drive
    python3 -m http.server -d dist
