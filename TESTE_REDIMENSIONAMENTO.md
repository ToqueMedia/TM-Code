# 🧪 Instruções de Teste - Painéis Redimensionáveis

## 🎯 **Cenários de Teste**

### **1. ✅ Teste Isolado (Funciona)**
```
URL: http://localhost:1420/?test=resize
```
**O que você verá:**
- Painel azul à esquerda com handle verde vertical
- Painel verde embaixo com handle verde horizontal  
- **DEVE FUNCIONAR** perfeitamente

### **2. 🆕 Teste Simplificado (Para debug)**
```
URL: http://localhost:1420/?debug=simple
```
**O que você verá:**
- IDE simplificado com ExplorerPanel real
- BottomPanel real
- **DEVE FUNCIONAR** como o teste isolado

### **3. ❌ Editor Completo (Problemático)**
```
URL: http://localhost:1420/ (padrão)
```
**O que você verá:**
- IDE completo original
- **PODE NÃO FUNCIONAR** devido a interferências

---

## 📋 **Como Testar**

### **Passo 1: Abrir projeto**
1. Abra a aplicação Tauri
2. Crie ou abra um projeto

### **Passo 2: Testar URLs**
1. **Primeiro teste**: `http://localhost:1420/?test=resize`
   - ✅ Deve funcionar (painéis azul e verde)
   
2. **Segundo teste**: `http://localhost:1420/?debug=simple`
   - 🆕 Deve funcionar (IDE simplificado)
   
3. **Terceiro teste**: `http://localhost:1420/` 
   - ❌ Pode não funcionar (IDE completo)

### **Passo 3: Verificar handles**
- **ExplorerPanel**: Procure linha verde **vertical** na borda direita
- **BottomPanel**: Procure linha verde **horizontal** na borda superior

---

## 🔍 **O que Procurar**

### **✅ Funcionando Corretamente:**
- **Handle visível**: Linha verde de 10px
- **Cursor muda**: ↔️ (horizontal) ou ↕️ (vertical)
- **Overlay aparece**: Mostra percentual durante drag
- **Console logs**: "🚀 Starting drag" e "🏁 Finished drag"
- **Não trava**: Movimento fluido

### **❌ Não Funcionando:**
- Handle invisível ou não responsiva
- Cursor não muda
- Trava durante o drag
- Sem overlay de percentual

---

## 🐛 **Debugging**

### **Console Logs Esperados:**
```
🚀 Starting drag for explorer-panel
🏁 Finished drag for explorer-panel
```

### **Inspecionar localStorage:**
```javascript
// No console do browser
localStorage.getItem('panel-size-explorer-panel')
localStorage.getItem('panel-size-bottom-panel')
```

### **Reset para teste:**
```javascript
// Limpar tamanhos salvos
localStorage.removeItem('panel-size-explorer-panel')
localStorage.removeItem('panel-size-bottom-panel')
location.reload()
```

---

## 📊 **Diagnóstico de Problemas**

### **Se o teste isolado funciona mas o IDE não:**
- **Problema**: Interferência de elementos CSS complexos
- **Solução**: Usar versão simplificada (`?debug=simple`)

### **Se nenhum funciona:**
- **Problema**: Erro no SimpleResizablePanel
- **Solução**: Verificar console para erros JavaScript

### **Se handles não aparecem:**
- **Problema**: Z-index ou sobreposição
- **Solução**: Procurar bordas verdes de debug

---

## 🚀 **Estratégia de Correção**

### **Fase 1: Confirmar que funciona**
1. ✅ Teste isolado deve funcionar
2. 🆕 Teste simplificado deve funcionar

### **Fase 2: Identificar diferenças**
- Comparar estrutura HTML
- Verificar estilos CSS interferindo
- Identificar elementos sobrepostos

### **Fase 3: Aplicar correções**
- Remover elementos interferindo
- Ajustar z-index
- Simplificar estrutura CSS

---

## 📝 **Status Atual**

- ✅ **SimpleResizablePanel**: Implementado e funcionando
- ✅ **Teste isolado**: Funciona perfeitamente
- 🆕 **Teste simplificado**: Criado para debug
- ❌ **IDE completo**: Precisa de correções

**🎯 Objetivo: Fazer o IDE completo funcionar igual ao teste isolado!**

---

## 🔧 **Próximos Passos**

1. **Teste as 3 URLs** na aplicação Tauri
2. **Compare o comportamento** entre elas
3. **Identifique onde está o problema** no IDE completo
4. **Reporte os resultados** para continuar a correção

**A solução está quase pronta! O código funciona, só precisa ser aplicado corretamente no IDE completo.**