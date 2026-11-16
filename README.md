# Fichário

Flashcards com repetição espaçada (FSRS) para a prova de residência médica. Funciona como o Anki, direto no navegador do iPhone e do Mac, e conversa com ele pelo formato `.apkg`.

## O que faz

- **Importa `.apkg` e `.colpkg`** do Anki (formato antigo e atual), com pastas, tags, imagens, áudios e o progresso de revisão.
- **Cria e edita cards** (frente/verso e lacunas), com cores por significado, tags e subbaralhos.
- **Exporta `.apkg`** do deck inteiro, com ou sem o progresso. O arquivo abre no Anki do computador, no AnkiMobile e no próprio Fichário de outro aparelho.
- **Caderno de erros**: questão errada, motivo do erro e catálogo de método.
- **Múltipla escolha**: cole a questão inteira e o app separa enunciado, alternativas, gabarito e comentário.
- **Jogo**: XP por resposta, níveis sem teto, sequência de dias e meta diária.
- **Heatmap** das revisões do último ano.
- **Foco**: Pomodoro com durações ajustáveis e lista de tarefas.
- **Backup completo** em um arquivo (Ajustes › Cópia de segurança), com restauração em qualquer aparelho.
- **Estatísticas** por grande área e por tema.
- **Funciona sem internet** depois da primeira abertura.

## Onde os dados ficam

Tudo fica guardado no próprio aparelho (no navegador). Nada é enviado para o GitHub nem para servidor nenhum, então o repositório pode ser público sem expor seus cards.

Consequências práticas:

- iPhone e Mac não se sincronizam sozinhos. Para levar um deck de um para o outro: abra o deck, **Preparar arquivo .apkg** com "Incluir meu progresso" marcado, e importe o arquivo no outro aparelho.
- Para levar **tudo** (todos os decks, XP, tarefas, caderno de erros): Ajustes › Cópia de segurança › Fazer backup agora, e Restaurar no outro aparelho.
- Se o navegador limpar os dados do site, só volta o que estiver num backup. O app avisa na tela inicial quando o último backup tem mais de 7 dias.
- "Gerar card com o Claude" só aparece quando o app é aberto dentro do Claude. Aqui, os cards são escritos à mão ou importados.

## Publicar no GitHub Pages

1. No repositório: **Settings › Pages**.
2. Em **Source**, escolha **Deploy from a branch**; em **Branch**, `main` e a pasta `/ (root)`. Salve.
3. Em um ou dois minutos o endereço aparece no topo da página: `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.

No plano gratuito do GitHub, o Pages exige repositório público.

## Instalar como app

- **iPhone**: abra o endereço no Safari, toque em Compartilhar e em **Adicionar à Tela de Início**.
- **Mac**: no Safari, **Arquivo › Adicionar ao Dock**. No Chrome, o ícone de instalar na barra de endereço.

Instale e passe a usar sempre pelo ícone: no iPhone, o app instalado e o Safari guardam os dados separados.

## Estrutura

```
index.html              telas do app
css/fichario.css        visual
js/core.js              leitura e escrita de .apkg, modelos de card do Anki
js/app.js               telas, estudo (FSRS), editor, caderno de erros, estatísticas
vendor/                 bibliotecas, copiadas para cá (o app não depende de CDN)
sw.js                   uso sem internet
manifest.webmanifest    instalação como app
icons/                  ícones
```

Não há etapa de build: os arquivos são servidos como estão.

## Ao alterar o app

- Mudou `js/` ou `css/`? Troque o `?v=...` das três linhas de `index.html` que carregam `css/fichario.css`, `js/core.js` e `js/app.js`. Isso garante que a página e o código cheguem juntos ao aparelho; sem isso, uma página nova pode rodar com código antigo por alguns minutos e abrir quebrada.
- Mudou `vendor/` ou `icons/`? Troque o valor de `VERSION` em `sw.js`.
