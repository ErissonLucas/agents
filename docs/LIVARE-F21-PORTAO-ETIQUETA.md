# F2.1: portão de resposta por etiqueta

- **Pedido:** "A IA só responde conversas que têm a etiqueta de atendimento por IA. Quando transfere para humano, tira
  essa etiqueta e põe a de transferido para humano. As etiquetas seguem as etapas do funil."
- **Setting:** `agent.settings.replyGate`, **desligada por padrão**. Um agente sem o bloco (ou com `enabled` diferente
  de `true`) se comporta exatamente como antes, e nenhuma leitura extra é feita para ele nas cercas do turno.
- **Código:** `src/modules/agents/reply-gate.ts` (leitor, veredito, movimentos de etiqueta, telemetria);
  `src/modules/ryze/labels.ts` (`applyReplyGateHandoff`); os pontos de fala listados abaixo.

## A setting

```json
"replyGate": {
  "enabled": true,
  "requiredLabel": "ia-atendendo",
  "handoffLabel": "com-vendedor",
  "removeOnHandoff": true
}
```

| Campo | Padrão | O que faz |
|---|---|---|
| `enabled` | `false` | só `true` liga |
| `requiredLabel` | — | a etiqueta sem a qual o agente não fala; obrigatória com o portão ligado (a escrita recusa `enabled` sem ela) |
| `handoffLabel` | nenhuma | posta na transferência; tem que ser diferente da exigida |
| `removeOnHandoff` | `true` | a transferência tira a exigida |

Validação na escrita (REST, console e MCP): `errors.replyGateNeedsLabel` e `errors.replyGateSameLabels`, só quando a
escrita muda o bloco. O console tem a seção "Responder só com etiqueta" na aba Comportamento. As etiquetas do portão
entram sempre na lista protegida do `set_labels`: o modelo não abre nem fecha o próprio portão.

## O veredito: na dúvida, fechado

Fechado (`reason` no log) quando:

| `reason` | Quando |
|---|---|
| `no_required_label` | ligado sem etiqueta exigida (bolsa gravada à mão) |
| `label_missing` | a conversa não tem a etiqueta |
| `label_unknown` | RyzeAPI: a etiqueta não está no catálogo vivo do número |
| `label_unsynced` | RyzeAPI: a linha do catálogo não tem id do WhatsApp, ou o número recusa etiquetas |
| `handed_off` | a etiqueta de transferência está na conversa |
| `human_takeover` | RyzeAPI: uma etiqueta com regra `human_takeover` está na conversa |
| `unreadable` | as etiquetas não puderam ser lidas |

No RyzeAPI a leitura é das nossas tabelas (`ryze_conversations.labels`, `ryze_labels`). No Chatwoot nativo é
`getConversationLabels`. A comparação de títulos ignora maiúsculas. A configuração é relida a cada pergunta
(desligar o portão vale no envio seguinte); se a releitura falhar, vale a que o turno carregou.

## Onde é perguntado (todos os caminhos de fala)

| # | Caminho | Ponto | Fechado → |
|---|---|---|---|
| 1 | Resposta direta e flush do debounce (texto, split balão a balão, botões e carrossel no último balão, áudio/TTS, anexos e documentos, reação do Jev, resposta do guardrail, ack de ferramenta lenta e ferramentas que falam, digitando/lido) | `writeCalledOff` em `graph/runtime.ts`, a cerca que toda escrita do turno já pergunta | o turno para; antes do invoke `taken-over-unread` (mensagem continua devida), depois `taken-over` (resposta tirada da memória, mensagem do cliente fica) |
| 2 | Recebimento (antes de STT, debounce, teto de gasto, autorização de contato, redirecionamento, ausência e do turno) | `maybeConsumeCommandOrGate` em `chatwoot/webhook.ts`, logo depois do portão do modo teste | a entrega é consumida; a ingestão contínua segue |
| 3 | Avisos públicos do receptor (link de redirecionamento, mensagem de ausência, frase do teto de gasto, recusa de autorização, acks de comando) | `postPublicMessage` | não envia; ack de comando vira nota privada |
| 4 | Nudge / follow-up / evento (`agent_nudge`), template fora da janela | `runAgentNudge`: antes do gasto com modelo, e na sonda de posse depois do modelo | `silent` sem chamar o modelo; depois do modelo, vira nota para a equipe como numa tomada |
| 5 | Frase do teto de gasto no flush | `debounce/handler.ts` | não envia (nota e transferência seguem) |
| 6 | Recuperação do áudio recusado (reenvio como texto) | `chatwoot/channel-failure.ts` | o job termina sem enviar |
| 7 | Link de follow-up do redirecionamento | `channel-redirect/followup.ts` | `stood-down` |
| 8 | **Retaguarda no transporte RyzeAPI**: qualquer mensagem, mídia ou reação de um agent bot | `RyzeEmulator.replyGateRefusal` | 422 `reply_gate_closed`, sem linha nem chamada à Ryze |

A retaguarda (8) cobre no RyzeAPI qualquer caminho que escape das cercas, inclusive o fechamento do redirecionamento.
Ela **não** pergunta: envio de pessoa (console sem token de bot), e conversa na fila humana (`open`) — ali todo
caminho do bot já é barrado pela posse, exceto a frase que a própria transferência prometeu.

**Isentos por desenho:** REST de operador (`/v1/ryze/gateways/:id/messages`, cartões) e a ponte de botões
(`forwardButtonReply`): não são a IA falando.

**Resposta em voo:** a pergunta é feita antes de cada balão, cada anexo e cada envio, e trava no primeiro "fechado"
do turno (nada é retomado). Transferência e tomada mudam o status para `open`, que a posse já barra. A janela
residual é a de uma leitura de banco até o POST.

**A própria transferência:** depois que o turno transferiu (`ownerChangedByTurn`), o portão não é perguntado: a
transferência tirou a etiqueta e a frase prometida ao cliente ainda é deste turno.

## Transferência: troca de etiquetas (RyzeAPI)

No emulador, toda mudança de status para `open` (o `handoff_to_human`, o handoff do guardrail, a tomada por resposta
humana — `takeover.onHumanReply` —, o teto de gasto e o console) chama `applyReplyGateHandoff`:

- tira `requiredLabel` (se `removeOnHandoff`) e põe `handoffLabel`, **só se ela já existir no catálogo do número**:
  a transferência nunca gasta uma das 20 vagas;
- dentro da fila de etiquetas da conversa (`withConversationLabels`), idempotente;
- anuncia `conversation_updated` e sincroniza com o WhatsApp pela sincronização existente (`assignTag`/`unassignTag`,
  em segundo plano, sem falhar o turno se o WhatsApp recusar).

A volta para o agente (`pending`) não recoloca nada: a etiqueta é concedida, nunca suposta. Quem concede: a
plataforma (preparação da conversa), o vendedor no celular, ou um operador.

No Chatwoot nativo não há troca automática na transferência (só o portão).

## Modo teste

- O portão vem depois do modo teste: um agente em teste numa conversa não ativada continua mudo pelo motivo de
  sempre.
- `/teste` e `/reset` continuam sendo tratados antes do portão. Com o portão ligado, os dois **põem a etiqueta
  exigida** (e tiram a de transferência), porque ativar o teste e devolver a conversa é entregá-la ao agente. O
  `/reset` faz isso depois de limpar as etiquetas.
- Agente em teste não faz ingestão contínua (como antes).

## Ingestão

Fechado no recebimento, a entrega é consumida pelo portão, e a ingestão contínua (memória do agente, espelho) segue
exatamente como numa mensagem fora do horário: o agente conhece a conversa quando a etiqueta volta. Fechado durante o
turno, a mensagem do cliente fica na memória e só a resposta não enviada é retirada.

## Telemetria

Cada retenção grava uma linha de log de processo e uma linha `handoff` no log de execução:

```json
{ "outcome": "reply_gate_closed", "reason": "label_missing", "seam": "receiver" }
```

`seam` ∈ `receiver`, `turn`, `nudge`, `notice`, `spend_ceiling`, `media_fallback`, `redirect_followup`, `transport`.
Sem texto do cliente nem do agente.

## Limites conhecidos

- Ligar o portão no meio de um turno só vale a partir do turno seguinte (o turno só relê quem carregou o portão).
- Uma etiqueta tirada no celular só vale depois que o evento `label.update` chega (ver `handleLabelUpdate`).
- Um `set_labels` concorrente à transferência no mesmo turno é serializado pela fila; a etiqueta exigida e a de
  transferência são protegidas, então o modelo não as move.
- Testes: `tests/modules/reply-gate.test.ts` (puros) e `tests/modules/ryze-reply-gate.test.ts` (ponta a ponta no
  emulador com banco de teste). Sem migração.
