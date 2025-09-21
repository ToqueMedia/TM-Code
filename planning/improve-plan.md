1. Fase 0: Preparação e Padronização do Ambiente (30 min)
**Objetivo**: Alinhar gestão de pacotes e preparar ferramentas de diagnóstico

1. **Padronizar Yarn como gestor de pacotes**
   - Remover `package-lock.json` se existir
   - Adicionar `"packageManager": "yarn@4.0.2"` ao `package.json`
   - Executar `yarn install` para gerar/atualizar `yarn.lock`
   - Adicionar `.npmrc` com `engine-strict=true`

2. **Instalar dependências de diagnóstico (DEV apenas)**
   - `yarn add -D @welldone-software/why-did-you-render@8.0.3` (verificar compatibilidade React 19)
   - `yarn add @tanstack/react-virtual@3.10.8` para virtualização
   - Configurar script `"benchmark": "vite build --mode benchmark && node scripts/perf.js"`

3. **Setup inicial de medição**
   - Criar `scripts/perf.js` com hooks de performance
   - Configurar React DevTools Profiler
   - Preparar dataset de teste (10k arquivos em estrutura de pastas)
2. Fase 1A: Análise Detalhada - FileTree Component (2h)
**Arquivo principal**: `src/components/ui/FileTree.tsx`

**Pontos de análise**:
1. **Renderização recursiva sem memoização** (P0)
   - Linhas ~50-150: componente TreeNode renderiza filhos sem React.memo
   - Impacto: Re-render completo da árvore a cada mudança de estado
   - Métrica: Medir re-renders com React DevTools Profiler

2. **Ausência de virtualização** (P0)
   - Linhas ~200-300: renderização de todos os nós visíveis
   - Impacto: DOM cresce linearmente com nós expandidos
   - Métrica: FPS durante scroll com 10k+ nós

3. **Menu/Dialog por nó** (P1)
   - Linhas ~180-220: ContextMenu criado para cada item
   - Impacto: Milhares de listeners e elementos ocultos
   - Métrica: Memória heap snapshot

4. **Selectors Zustand ineficientes** (P0)
   - Linhas ~30-45: uso de múltiplas subscriptions
   - Verificar uso de destructuring vs seletores individuais

5. **Gradientes e estilos pesados** (P1)
   - Linhas diversas: background gradients, shadows complexas
   - Impacto: Repaint/reflow custoso
3. Fase 1B: Análise Detalhada - Editor Components (2h)
**Arquivos**: `src/components/CodeEditorNew.tsx`, `src/components/ui/MonacoEditor.tsx`

**CodeEditorNew.tsx**:
1. **Tab management sem memoização** (P0)
   - Linhas ~100-200: TabList re-renderiza todos os tabs
   - Proposta: React.memo com comparação customizada

2. **Context menus redundantes** (P1)
   - Linhas ~250-300: múltiplas instâncias de menus
   - Proposta: Menu singleton com portal

3. **Decorativos e gradientes** (P2)
   - Verificar uso de backgrounds complexos

**MonacoEditor.tsx**:
1. **Opções e listeners** (P0)
   - Linhas ~50-100: recreação de options object a cada render
   - Proposta: useMemo para opções estáveis

2. **Remounts desnecessários** (P0)
   - Verificar key props e condições de remount
   - Impacto: Perda de estado do editor e lag

3. **Integração com stores** (P1)
   - Analisar subscriptions e atualizações
4. Fase 1C: Análise Detalhada - Stores (1.5h)
**fileTreeStore.ts**:
1. **Verificar eficiência do índice O(1)** (P1)
   - Confirmar Map/Set usage
   - Analisar impacto nas views
   - Métricas: Tempo de lookup com 50k arquivos

**editorStore.ts**:
1. **Conteúdo em memória** (P0)
   - Verificar armazenamento de file contents
   - Proposta: LRU cache com limite configurável
   - Métrica: Memória com N arquivos abertos

2. **Undo/redo custom** (P0)
   - Analisar implementação atual
   - Verificar granularidade e limites
   - Proposta: Batching por tempo/caracteres ou usar Monaco nativo

3. **Auto-save frequência** (P1)
   - Verificar debounce/throttle
   - Métrica: I/O por minuto

**projectStore.ts**:
1. **Window state e persist** (P2)
   - Verificar frequência de persistência
   - Analisar watchers e listeners
5. Fase 1D: Análise LSP/Monaco Service (1h)
**Arquivo**: `src/services/typescriptLspService.ts`

1. **Carregamento de modelos** (P0)
   - Verificar criação eager vs lazy
   - Analisar limite atual de modelos
   - Proposta: On-demand + descarte ao fechar arquivo
   - Métrica: Memória com N modelos carregados

2. **Sincronização e updates** (P1)
   - Verificar debounce de validação
   - Analisar custo de type checking

3. **Providers e completions** (P1)
   - Verificar cache de resultados
   - Analisar performance de suggestions
6. Fase 2: Documentação de Achados e Priorização (2h)
**Entregável**: Relatório técnico estruturado

```markdown
# Relatório de Performance - ToqueMedia Studio

## Sumário Executivo
- Total de issues encontradas: X (P0: Y, P1: Z, P2: W)
- Impacto estimado: XX% melhoria em render time, YY% redução memória
- Tempo estimado Quick Wins: 2-3 dias

## Issues P0 (Quick Wins - Implementar Imediatamente)

### 1. FileTree: Ausência de React.memo
**Arquivo**: src/components/ui/FileTree.tsx
**Linhas**: 50-150
**Problema**: TreeNode re-renderiza todos os filhos a cada mudança
**Impacto**: 500ms+ lag com 1000 nós
**Solução**:
```diff
- function TreeNode({ node, level }) {
+ const TreeNode = React.memo(function TreeNode({ node, level }) {
    // component code
- }
+ }, (prevProps, nextProps) => {
+   return prevProps.node.id === nextProps.node.id &&
+          prevProps.node.expanded === nextProps.node.expanded &&
+          prevProps.level === nextProps.level
+ })
```
**Métrica**: Re-renders reduzidos de 1000 para ~10 por interação

### 2. MonacoEditor: Options Recreation
[Continuar padrão similar para cada issue]

## Issues P1 (Otimizações Moderadas)
[Listar com mesmo formato]

## Issues P2 (Melhorias Futuras)
[Listar com mesmo formato]
```
7. Fase 3: Implementação Quick Wins (2-3 dias)
**Checklist de implementação imediata**:

□ **FileTree Memoization** (4h)
  - Adicionar React.memo ao TreeNode
  - Implementar comparação customizada
  - Testar com dataset grande

□ **Monaco Options Stability** (2h)
  - Wrap options em useMemo
  - Estabilizar event handlers com useCallback
  - Verificar re-mounts

□ **Zustand Selectors Optimization** (3h)
  - Converter destructuring para seletores individuais
  - Criar seletores memoizados para dados derivados
  - Adicionar shallow comparison onde aplicável

□ **LRU Cache para Editor Content** (4h)
  - Implementar cache com limite configurável
  - Adicionar métricas de hit/miss
  - Integrar com editorStore

□ **Debounce Auto-save** (1h)
  - Aumentar delay para 2s
  - Implementar batching de saves
  - Adicionar indicador visual de save status

□ **Remove Gradients** (2h)
  - Substituir por cores sólidas
  - Simplificar shadows
  - Medir impacto em paint time
8. Fase 4: Virtualização do FileTree (3 dias)
**Implementação com @tanstack/react-virtual**:

1. **Preparação dos dados** (4h)
   - Criar função flatten para árvore visível
   - Manter índice de nós expandidos
   - Calcular altura total

2. **Integração React Virtual** (6h)
   ```typescript
   import { useVirtualizer } from '@tanstack/react-virtual'
   
   function VirtualFileTree({ nodes }) {
     const flatNodes = useMemo(() => flattenVisibleNodes(nodes), [nodes])
     
     const virtualizer = useVirtualizer({
       count: flatNodes.length,
       getScrollElement: () => parentRef.current,
       estimateSize: () => 28, // altura do item
       overscan: 5
     })
     
     return (
       <div ref={parentRef} style={{ height: '100%', overflow: 'auto' }}>
         <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
           {virtualizer.getVirtualItems().map((virtualItem) => (
             <TreeNode
               key={flatNodes[virtualItem.index].id}
               node={flatNodes[virtualItem.index]}
               style={{
                 position: 'absolute',
                 top: 0,
                 left: 0,
                 transform: `translateY(${virtualItem.start}px)`
               }}
             />
           ))}
         </div>
       </div>
     )
   }
   ```

3. **Manter funcionalidades** (4h)
   - Preservar keyboard navigation
   - Manter multi-seleção
   - Garantir acessibilidade (ARIA)

4. **Testing e ajustes** (4h)
   - Testar com 50k+ arquivos
   - Ajustar overscan para smooth scroll
   - Verificar memory footprint
9. Fase 5: Otimização LSP On-Demand (2 dias)
**Refactor do typescriptLspService.ts**:

1. **Lazy Model Creation** (4h)
   ```typescript
   class TypeScriptLSPService {
     private modelCache = new Map<string, monaco.editor.ITextModel>()
     private maxModels = 20
     
     async getOrCreateModel(uri: string): Promise<ITextModel> {
       if (this.modelCache.has(uri)) {
         return this.modelCache.get(uri)!
       }
       
       // Evict LRU if at capacity
       if (this.modelCache.size >= this.maxModels) {
         const lru = this.findLRU()
         lru?.dispose()
         this.modelCache.delete(lru.uri.toString())
       }
       
       const model = monaco.editor.createModel(...)
       this.modelCache.set(uri, model)
       return model
     }
     
     async closeModel(uri: string): Promise<void> {
       const model = this.modelCache.get(uri)
       model?.dispose()
       this.modelCache.delete(uri)
     }
   }
   ```

2. **Background Indexing** (4h)
   - Implementar worker para indexação
   - Queue de prioridade para arquivos abertos
   - Cache de símbolos e definições

3. **Debounced Validation** (2h)
   - Aumentar delay para 500ms
   - Validar apenas arquivo ativo
   - Cache de erros/warnings
10. Fase 6: Sistema de Medição e Benchmarks (1 dia)
**Setup de benchmarking contínuo**:

1. **Scripts de medição** (`scripts/benchmark.js`):
   ```javascript
   import { performance } from 'perf_hooks'
   
   const benchmarks = {
     fileTreeExpand: async () => {
       const start = performance.now()
       await expandLargeDirectory() // 1000 files
       return performance.now() - start
     },
     
     editorOpen: async () => {
       const start = performance.now()
       await openFile('large-file.ts') // 10k lines
       return performance.now() - start
     },
     
     scrollPerformance: async () => {
       const fps = await measureScrollFPS()
       return fps
     }
   }
   
   // Run and report
   const results = {}
   for (const [name, bench] of Object.entries(benchmarks)) {
     results[name] = await bench()
   }
   
   console.table(results)
   ```

2. **KPIs Target**:
   - FileTree expand/collapse: <50ms para 1000 itens
   - Scroll FPS: >55fps com 10k nós visíveis
   - Editor typing latency: <16ms p95
   - Memory per file: <500KB average
   - Auto-save I/O: <10 writes/minute

3. **CI Integration**:
   ```yaml
   # .github/workflows/performance.yml
   - name: Run Performance Benchmarks
     run: yarn benchmark
   - name: Compare with baseline
     run: node scripts/compare-perf.js
   ```

4. **Dashboard de métricas** (opcional):
   - Grafana ou similar para tracking histórico
   - Alertas para regressões >10%
11. Fase 7: Validação e Documentação Final (1 dia)
**Checklist de validação**:

□ **Medições antes/depois de cada Quick Win**
  - Documentar em tabela comparativa
  - Screenshots do profiler

□ **Testes de stress**:
  - 50k arquivos em tree
  - 100 tabs abertos
  - Arquivos de 1MB+
  - Sessão de 4h contínuas

□ **Documentação de trade-offs**:
  - Virtualização vs find-in-tree complexity
  - LRU cache size vs memory
  - Auto-save frequency vs data loss risk

□ **Guia de manutenção**:
  - Como adicionar novos benchmarks
  - Quando revisar limites de cache
  - Sinais de regressão de performance

□ **Comunicação com equipe**:
  - PR com antes/depois métricas
  - Video demo das melhorias
  - Roadmap de otimizações futuras