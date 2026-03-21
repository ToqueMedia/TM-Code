# TM Code — Editor Feature Roadmap

Features em falta comparado com Cursor/VS Code (sem IA). Organizadas por prioridade de impacto no developer experience.

---

## Prioridade Média

### Go to References (Shift+F12)
Mostrar todas as referências de um símbolo no projecto. Similar ao Go to Definition, requer um `ReferenceProvider` cross-file. O Monaco mostra os resultados num peek widget com lista navegável.

### Code Actions / Quick Fix (Cmd+.)
Mostrar o menu "lightbulb" com acções de código disponíveis: auto-fix de erros TypeScript, adicionar import em falta, extrair variável/função, etc. Requer registar um `CodeActionProvider`. O TypeScript language worker já fornece algumas acções — basta wiring.

### Outline / Symbol Panel (Sidebar)
Adicionar um painel na sidebar que mostra a estrutura do documento: funções, classes, variáveis, exports. Usa os dados do `DocumentSymbolProvider` do Monaco. O user clica num símbolo para navegar. Icones por tipo (função, classe, variável, interface).

### Pin Tabs
Permitir fixar tabs para que não sejam fechados com "Close Others" ou "Close All". Adicionar `isPinned: boolean` ao `EditorFile` no editorStore. Tabs pinned aparecem primeiro, com ícone de pin, largura reduzida. Acção "Pin/Unpin Tab" no context menu do tab.

### Auto-Import (Full Symbol Import)
Quando o user aceita uma sugestão de autocomplete para um símbolo não importado, adicionar automaticamente a linha de import no topo do ficheiro. Requer `CompletionItemProvider` com `additionalTextEdits` que insere o import. O TypeScript language worker fornece esta informação — basta wiring.

### Inline Git Blame
Mostrar autor e data relativa no fim da linha activa em texto esbatido (estilo GitLens). Requer comando Rust que execute `git blame` para o ficheiro e retorne dados por linha. Aplicar como decoração Monaco no fim da linha do cursor.

### Zoom (Cmd+Plus / Cmd+Minus)
Permitir aumentar/diminuir o tamanho da fonte do editor com Cmd+= e Cmd+-. Guardar o zoom level no settingsStore. Aplicar via `editor.updateOptions({ fontSize })`. Registar no Command Palette como "Zoom In", "Zoom Out", "Reset Zoom".

### Theme Switching UI
Adicionar um picker no Command Palette ou nos Settings para trocar entre temas (actualmente: toquemedia-vibrant e toquemedia-soft). Registar comando "Color Theme" que abre um picker com preview ao hover.

### Tab Context Menu expandido
Adicionar opções ao menu de contexto dos tabs: "Close to the Right", "Close Saved", "Copy Path", "Copy Relative Path", "Reveal in Explorer". Actualmente só tem Close, Close Others, Close All.

### Word Wrap Toggle
Adicionar um comando "Toggle Word Wrap" no Command Palette e um atalho (Alt+Z, como VS Code). Actualmente word wrap está sempre ligado sem forma de desligar.

---
