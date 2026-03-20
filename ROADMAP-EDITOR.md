# TM Code — Editor Feature Roadmap

Features em falta comparado com Cursor/VS Code (sem IA). Organizadas por prioridade de impacto no developer experience.

---

## Prioridade Alta

### Split Editor / Side-by-Side
Permitir abrir dois ficheiros lado a lado (ex: componente + teste, tipo + consumidor). O user deve poder arrastar um tab para a metade direita do editor, ou usar Cmd+\ para dividir. O Monaco suporta múltiplas instâncias de editor — o trabalho é no layout manager para gerir editor groups (esquerda/direita), resize handle, e sincronização de tabs.

### Git Gutter + Source Control Panel
Mostrar barras coloridas no gutter do editor para linhas adicionadas (verde), modificadas (azul) e removidas (vermelho) comparado com o último commit. Requer um comando Rust backend que execute `git diff` e retorne os ranges de linhas alteradas. Aplicar decorações Monaco no gutter. Num segundo passo, adicionar um painel Source Control na sidebar com: lista de ficheiros alterados, staging/unstaging, input de commit message, e botão de commit.

### Rename Symbol (F2)
Ao pressionar F2 num símbolo, abrir um inline input para renomear. O rename deve propagar para todas as referências no projecto. Para TypeScript/JavaScript, o Monaco language worker fornece rename via `registerRenameProvider`. O desafio é fazer rename cross-file — requer que os modelos dos ficheiros referenciados estejam carregados.

### Code Formatting (Prettier)
Formatar o documento activo com Prettier ao pressionar Shift+Alt+F ou ao salvar (opção configurável). Requer integrar Prettier como dependência ou chamar o binário via Rust backend. Adicionar setting `formatOnSave: boolean` ao settingsStore. Registar a acção no Command Palette como "Format Document".

### Tab Drag-and-Drop
Permitir reordenar tabs arrastando-os. Usar HTML5 drag-and-drop nativo ou uma biblioteca leve. Ao soltar, actualizar a ordem do array `openFiles` no editorStore. Visual feedback durante o drag (indicador de drop position).

---

## Prioridade Média

### Peek Definition (Alt+F12)
Ao pressionar Alt+F12, mostrar a definição do símbolo num widget inline (sem navegar para outro ficheiro). O Monaco suporta peek widgets nativamente se o `DefinitionProvider` estiver registado — funciona automaticamente após implementar Go to Definition.

### Go to References (Shift+F12)
Mostrar todas as referências de um símbolo no projecto. Similar ao Go to Definition, requer um `ReferenceProvider` cross-file. O Monaco mostra os resultados num peek widget com lista navegável.

### Code Actions / Quick Fix (Cmd+.)
Mostrar o menu "lightbulb" com acções de código disponíveis: auto-fix de erros TypeScript, adicionar import em falta, extrair variável/função, etc. Requer registar um `CodeActionProvider`. O TypeScript language worker já fornece algumas acções — basta wiring.

### Outline / Symbol Panel (Sidebar)
Adicionar um painel na sidebar que mostra a estrutura do documento: funções, classes, variáveis, exports. Usa os dados do `DocumentSymbolProvider` do Monaco. O user clica num símbolo para navegar. Icones por tipo (função, classe, variável, interface).

### Pin Tabs
Permitir fixar tabs para que não sejam fechados com "Close Others" ou "Close All". Adicionar `isPinned: boolean` ao `EditorFile` no editorStore. Tabs pinned aparecem primeiro, com ícone de pin, largura reduzida. Acção "Pin/Unpin Tab" no context menu do tab.

### Emmet (HTML/CSS Expansion)
Expandir abreviações Emmet em ficheiros HTML/CSS/JSX (ex: `div.container>ul>li*3` → markup completo). Integrar a library `emmet-monaco-es` ou registar um `CompletionItemProvider` que usa o core Emmet. Trigger com Tab após uma abreviação.

### Auto-Import (Full Symbol Import)
Quando o user aceita uma sugestão de autocomplete para um símbolo não importado, adicionar automaticamente a linha de import no topo do ficheiro. Requer `CompletionItemProvider` com `additionalTextEdits` que insere o import. O TypeScript language worker fornece esta informação — basta wiring.

---

## Prioridade Baixa

### Zoom (Cmd+Plus / Cmd+Minus)
Permitir aumentar/diminuir o tamanho da fonte do editor com Cmd+= e Cmd+-. Guardar o zoom level no settingsStore. Aplicar via `editor.updateOptions({ fontSize })`. Registar no Command Palette como "Zoom In", "Zoom Out", "Reset Zoom".

### Theme Switching UI
Adicionar um picker no Command Palette ou nos Settings para trocar entre temas (actualmente: toquemedia-vibrant e toquemedia-soft). Registar comando "Color Theme" que abre um picker com preview ao hover.

### Tab Context Menu expandido
Adicionar opções ao menu de contexto dos tabs: "Close to the Right", "Close Saved", "Copy Path", "Copy Relative Path", "Reveal in Explorer". Actualmente só tem Close, Close Others, Close All.

### Word Wrap Toggle
Adicionar um comando "Toggle Word Wrap" no Command Palette e um atalho (Alt+Z, como VS Code). Actualmente word wrap está sempre ligado sem forma de desligar.

### Preview Mode Tabs
Single-click num ficheiro no Explorer abre em modo preview (título em itálico, substituído pelo próximo single-click). Double-click abre permanentemente. Adicionar `isPreview: boolean` ao EditorFile. Preview tab é substituído quando outro ficheiro é previewed.

---

## Longo Prazo

### Extensions / Plugins
Sistema de extensões que permita adicionar languages, themes, snippets, e providers via plugins. Arquitectura similar ao VS Code extension API mas mais simples. Inclui: extension manifest, activation events, contribuição de comandos/menus/settings. Complexidade muito alta — considerar apenas após as features core estarem sólidas.

### Inline Git Blame
Mostrar autor e data relativa no fim da linha activa em texto esbatido (estilo GitLens). Requer comando Rust que execute `git blame` para o ficheiro e retorne dados por linha. Aplicar como decoração Monaco no fim da linha do cursor.
