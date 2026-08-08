# Hooks

Comandos do developer que correm à volta das tuas tool calls, para IMPOR regras do projecto que a instrução escrita não garante. Usa esta skill quando o developer pedir para bloquear, forçar, garantir ou verificar automaticamente alguma coisa em cada escrita — "impede-me de…", "garante que…", "não deixes escrever…", "corre X sempre que…". Config em `.toquemedia/hooks.json`; és tu que a escreves.

**Não confundir com git hooks** (`.husky/`, `pre-commit`): esses correm no
commit e não impedem nada do que TU escreves durante a conversa. Se o developer
quer a garantia aplicada a cada escrita tua, é aqui.

## CRITICAL — quando propor um hook

Propõe um hook quando o developer descreve uma regra que quer **garantida**, não lembrada. O sinal é ele repetir uma correcção, ou pedir "não voltes a…".

Não proponhas hook para regras universais de bom código (tratar estados vazios, nomes claros): essas já vivem no prompt e um hook por projecto obrigaria cada repo a reescrevê-las. Hooks servem regras **deste projecto** — a stack dele, os ficheiros dele, os comandos dele.

**E só regras SINTÁCTICAS.** Um hook é `grep`: vê texto, não intenção. Serve
"usa `var(--…)` em vez de `#hex`" ou "não importes de `src/legacy/`" — o
padrão está lá ou não está. NÃO serve "trata o estado vazio", "dá bons nomes",
"não sobre-abstraias": para isso é preciso saber se ESTA colecção pode vir
vazia, e um detector que tente adivinhar ou tem falsos positivos (bloqueia
`TABS.map` sobre uma constante) ou tem pontos cegos (deixa passar o array
declarado no próprio ficheiro). Medido a 2026-08-06: os dois, no mesmo
detector. Se a regra precisa de julgamento, o sítio dela é o prompt — e diz
isso ao developer em vez de fabricar um guarda que parece guardar e não
guarda.

## CRITICAL — o caminho é load-bearing

O ficheiro TEM de estar em **`.toquemedia/hooks.json`**, relativo à raiz do
projecto. Noutro sítio (raiz, `.tms/`, ao lado de um `.example`) é
**silenciosamente ignorado**: não há erro, não há aviso, o hook nunca corre e
tudo parece bem. Já aconteceu numa medição — config perfeita, na raiz, morta.

## Formato

```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit|create_file|write_file|edit_file",
      "hooks": [{ "type": "command", "command": "sh ./scripts/check.sh" }]
    }
  ]
}
```

- **Eventos**: `PreToolUse` (antes da tool) e `PostToolUse` (depois).
- **`matcher`**: regex contra o nome da tool **como tu a vês** (`Write`, `Bash`, `Edit`), não o id interno.
- **Comando**: corre com o cwd na raiz do projecto. Recebe o evento em **JSON no stdin**:
  `{ hook_event_name, tool_name, tool_input, tool_response (só no Post), session_id, cwd }`

## Contrato de saída — o que decide se a regra tem dentes

| saída | efeito |
|---|---|
| **exit 2** + razão no **stderr** | IMPÕE. No `PreToolUse` a tool não corre; no `PostToolUse` o resultado volta como erro |
| stdout `{"hookSpecificOutput":{"additionalContext":"…"}}` | conselho. **Medido: não muda comportamento** |
| `{"decision":"block","reason":"…"}` | bloqueia, como o exit 2 |
| exit 0 sem saída | silêncio |

**Se o developer quer garantia, usa exit 2.** O `additionalContext` foi medido em 5/10 — igual a não haver hook. O mesmo detector com exit 2 deu 10/10.

## CRITICAL — três armadilhas medidas

1. **No `PostToolUse` de uma escrita, o ficheiro AINDA NÃO ESTÁ NO DISCO.** A escrita real acontece depois, na aprovação do diff. Um hook com `[ -f "$FILE" ]` sai em silêncio e não faz nada. Lê `tool_input.content` do payload.
2. **O agente contorna.** Bloqueado no `Write`, tenta `Bash`, `create_file` e `Edit`. O matcher tem de cobrir todos: `Write|Edit|create_file|write_file|edit_file` (e `Bash` se a regra puder ser violada por shell).
3. **Só fala quando há algo a dizer.** Um hook que bloqueia casos legítimos ensina a ignorá-lo — e ele passa a ser ruído caro. Testa o script à mão contra ficheiros bons E maus antes de o ligar:
   `echo '{"tool_input":{"file_path":"x.jsx","content":"…"}}' | sh ./scripts/check.sh; echo $?`

## Exemplo completo

Regra: este projecto tem design tokens em `src/theme/tokens.css`; recusar cores cruas.

```sh
#!/bin/sh
PAYLOAD=$(cat)
FILE=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$FILE" in *.jsx|*.tsx|*.css) ;; *) exit 0 ;; esac
printf '%s' "$PAYLOAD" | grep -q 'var(--' && exit 0
printf '%s' "$PAYLOAD" | grep -qiE '#[0-9a-f]{3,8}' || exit 0
echo "Recusado: usa os tokens de src/theme/tokens.css (var(--…)) em vez de cores cruas." >&2
exit 2
```

Medido neste caso: **37% de falha sem hook → 0 em 10 com ele**.

Notas de portabilidade: `sed 's/\(a\|b\)//'` é GNU — no BSD sed do macOS não corta nada **e não dá erro**. Usa duas substituições. Evita `grep -P`.

## Depois de criar

Diz ao developer o que o hook impede, mostra-lhe o comando para o testar à mão, e avisa que os hooks correm em **série** e que o primeiro bloqueio interrompe os seguintes.
