# F2.1-A: envio incerto no RyzeAPI nunca é reenviado

- **Pacote:** F2.1-A, local, sobre `integ/livare-maria` `f60a0b9`.
- **Escopo:** só o envio pelo emulador RyzeAPI (texto, botões, carrossel, mídia, anexo e áudio), a releitura que
  decide reenvio, o turno que o consome, o follow-up que dependeria dele e a nota ao próximo turno.
- **A F2.1 inteira NÃO está pronta:** ACK de ferramenta, REST do operador, ponte de botões e reação continuam
  fora (ver "Limites").

## O defeito

Até `f60a0b9`, a sequência era esta:
1. O emulador apagava a linha do envio em qualquer erro.
2. A releitura (`split/service.ts`) concluía "ausente".
3. O laço reenviava.

Quando o RyzeAPI aceitava a mensagem e a resposta se perdia (timeout, conexão caída, 5xx depois do aceite), o
cliente recebia o balão duas vezes. Reproduzido em `85fe2da` pelo diagnóstico D1.

## A regra

**Nada é apagado.** A linha é gravada antes de chamar o provedor e recebe um destino:

| Estado | `status` | `content_attributes.fazer_ai_ryze_delivery` | Quando |
|---|---|---|---|
| em voo | `fazer_ai_sending` | `sending` | antes da chamada ao provedor |
| nunca despachado | `fazer_ai_not_dispatched` | `not_dispatched` | falha **antes** de `ryze.send*`, por exemplo o cliente do gateway não pôde ser construído |
| incerto | `fazer_ai_uncertain` | `uncertain` | qualquer falha **depois** do início da chamada: timeout, reset, qualquer 4xx/5xx, `success:false` |
| aceite do provedor | `sent` | `provider_accepted` | o provedor devolveu o aceite |
| aceite não registrado | `sent` | `provider_accepted_unrecorded` | aceito, mas a marcação de atividade da conversa falhou duas vezes |

- **O `messageId` do RyzeAPI prova o aceite do provedor,** não a entrega no aparelho nem a leitura.
- **O `status: "sent"` continua o mesmo para os leitores.** Os estados internos usam nomes novos.
- O estado é escrito só pelo emulador: um `fazer_ai_ryze_delivery` enviado pelo chamador é descartado.

**Reenvio:** só com prova durável.
- A releitura do Ryze (`accountForRejectedSend` → `ryzeSendVerdict`) consulta a linha pelo nome do envio
  (`fazer_ai_send_id`).
- Ela permite reenviar **apenas** quando existe exatamente uma linha `not_dispatched` sem id do provedor.
- 422, 500, 503, timeout ou ausência local nunca bastam. Também dão "desconhecido" estes casos:
  - nenhuma linha;
  - duas ou mais linhas;
  - estado contraditório;
  - linha `sending`;
  - consulta falha.
- "Desconhecido" significa: sem reenvio e `unproven` (selo).

**Consulta por nome:** `GET …/conversations/:id/messages?send_id=`.
- Responde só ao token de um bot **deste** gateway. O token admin do emulador é uma constante e recebe 401.
- É restrita ao tenant (transação), ao gateway e à conversa do caminho.
- Devolve todas as linhas com o nome, e quem decide é o chamador.

**Histórico:**
- `listMessages` e `latestMessageId` escondem só os três estados internos.
- Continuam visíveis: mensagens de entrada, de pessoas, do aparelho, legadas (inclusive `sending` antigo sem o
  marcador), `delivered`/`read` e aceitas.
- Nenhum leitor do histórico confunde tentativa com resposta entregue, humana ou fronteira de conversa.

**Aceite × falha local:**
- Aceito pelo provedor nunca vira incerto.
- A gravação é tentada duas vezes e depois reduzida à linha (`provider_accepted_unrecorded`).
- Se nem isso gravar, o chamador ainda recebe 200, e a linha fica `sending` (lida como desconhecida, nunca como
  ausente).
- O eco aos bots é melhor esforço e não altera o envio.

## Onde o runtime consome

- **Texto, botões e carrossel:** o laço do split consulta o registro, e um incerto vira
  `{failed:true, unproven:true}`. Com nada entregue, o turno não lança. Com `posted-partial` e o selo, a
  conversa não fecha.
- **Anexo:** o veredito é o mesmo por envio. Incerto conta como `unproven`, não como `failed`, então o turno
  só-de-anexo não lança e não re-executa.
- **Áudio (TTS):** um áudio incerto não cai para texto, porque isso seria uma segunda mensagem. Só um áudio
  `not_dispatched` cai.
- **Selo ao operador:** `lastError`, com texto próprio para o Ryze ("o provedor do WhatsApp não confirmou o
  aceite… Nada foi reenviado"), visível na lista de conversas.
- **Re-execução:** o flush resolve sem lançar no caso incerto (o scheduler não repete o turno). No caso nunca
  despachado continua lançando, como antes.

## Follow-up e resolve automáticos

- **O problema:** `ourSideHasSpoken` lê a reivindicação da resposta, gravada antes do envio.
- **A trava:** com saída do bot não aceita, mais nova que a última aceita, o `followUpHandler` encerra o
  episódio **antes** de `runAgentNudge`, sem nudge, etiquetas nem resolve. Ele carimba `last_follow_up_at`
  (`stampUnlessRetired`) para a varredura não reentrar a cada minuto.
- **O que a trava não bloqueia:**
  - a próxima mensagem do cliente, que é tratada normalmente e abre um episódio novo;
  - lembretes de agendamento, `agent_nudge` externo e follow-up de redirect, que não derivam da saída;
  - o turno de nova mensagem.
- **Resolve diferido do próprio turno:** já é pulado em `posted-partial` (testado).
- **`nothing-to-answer`:** só fecha conversas sem nenhuma mensagem respondível do cliente, então não alcança um
  turno com tentativa incerta.

## Memória

- O thread do agente guarda a resposta produzida (o invoke persiste antes do envio). Nada no histórico é
  apagado ou reescrito.
- Enquanto as tentativas não aceitas forem a palavra mais recente do nosso lado, o input do próximo turno leva
  uma nota `<envio_nao_confirmado>`.
- A nota some quando um envio posterior é aceito.

## Testes

`tests/modules/ryze-send-uncertain.test.ts` usa emulador, store, ChatwootClient, split, runtime, flush, varredura
e handler de follow-up reais sobre PostgreSQL; só o HTTP do RyzeAPI e o modelo são falsos.

| Aceite | Cobertura |
|---|---|
| A1 | split ligado com timeout, reset, 500 e 400 depois do despacho; controle 500 sem aceite; runtime split ligado |
| A2 | split desligado (laço e turno direto) |
| A3 | botões e carrossel |
| A4 | anexo só-de-anexo incerto; controle nunca despachado |
| A5 | áudio incerto sem fallback; controle nunca despachado cai para texto |
| A6 | `not_dispatched` mantido e reenvio só com essa prova; controles negativos: 422 sem linha, duas linhas, estado contraditório |
| A7 | falha local depois do aceite: conversa recusada e linha inteira recusada |
| A8 | falha da entrega do eco |
| A9 | `sending` em voo é desconhecido |
| A10 | flush: incerto resolve; nunca despachado lança |
| A11 | Chatwoot nativo inalterado com estado forjado; consulta Ryze recusa o cliente nativo |
| A12 | histórico preserva entrada, legado e `delivered` |
| A13 | estado forjado pelo chamador descartado |
| A15 | selo na lista do operador e conversa não resolvida |
| A17 | admin constante, sem token, bot de outro gateway e outro tenant: 401/404/nada |
| Demais | resolve diferido, follow-up (L-F) e nota de memória |

## Limites (não cobertos, e impedem declarar a F2.1 pronta)

- **ACK de ferramenta** (`prepare.ts` `emitAck`): sem retry próprio. Como o turno incerto não re-executa mais, o
  reenvio pelo turno caiu, mas o ACK em si não consulta registro.
- **REST do operador e ponte de botões** (`interactive.ts` `sendAsAgent`, `forwardButtonReply`): chamam o
  `RyzeClient` direto, fora destes estados.
- **Reação.**
- **Idempotência no RyzeAPI** (chave por envio ou consulta por id): não verificada. Sem ela, nenhum retry de
  envio incerto é seguro.
- **Reconciliação incerto → aceito pelo eco do próprio número:** é inbound e ficou fora.
- **Falso incerto num 4xx real:** fica visível ao operador pelo selo, sem reenvio, sem lista de exceções até
  haver evidência do comportamento do RyzeAPI.
- **Linha `sending` órfã depois de queda no meio do envio:** fica oculta e "desconhecida" para sempre, e segura
  o follow-up dessa conversa até um envio posterior ser aceito.
- **Corrida de timeout:** o emulador in-process ignora o `AbortSignal` do cliente, então o cliente sempre espera
  o desfecho do emulador. Uma linha `sending` só é vista por releitura concorrente ou depois de queda.
