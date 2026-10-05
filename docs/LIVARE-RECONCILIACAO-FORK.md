# Reconciliação local do fork Livare — 05/10/2026

Coordenador: Codex. Ramo isolado `integ/livare-maria`, criado em `85fe2da` e unido a `8a96e8d` por merge, preservando ambos os históricos. `feat/maria-approvals` e `feat/livare-producao` permanecem intocados. Nenhum push ou produção.

## Resolução

Único conflito textual: `src/modules/ryze/interactive.ts`, inserções após `validateText`. Preservados integralmente os validadores de botões/carrossel de MarIA e os validadores/escritores de contexto da Livare. Os testes de interactive tiveram merge automático revisado. Nenhuma mudança de política de envio neste pacote. O portão completo revelou a necessidade de uma migração de nomes, descrita abaixo.

A união preserva human_takeover pelo aparelho, automation sources, duas pontes, ferramentas buttons/carousel, arrays de objetos e Jev do lado MarIA; contexto REST de conversa e correções de paths/UTC dos testes do lado Livare. Isso não habilita Jev, agentes ou envios na Livare.

## Verificação

Bun 1.4.2 isolado, banco sintético derivado deste worktree, executor `rodar_v2.py` do handoff. Sem `--pg-utc`: UTC vem do harness integrado. Dependências e cliente Prisma em symlink; fontes e locales são próprios do worktree. Shims `.husky/_` copiados antes do commit para executar o hook real.

`db:test:setup` passou. Testes direcionados: interactive 28, send-context-db 5, channel 12, labels-db 15, split 81, Jev 6: **147 passaram, zero falhas**. O teste de contexto exercita a combinação emulador/interactive, inclusive o ciclo de imports. O resultado do portão completo será registrado na coordenação após o pre-commit; este documento não antecipa esse resultado.

## Limites que bloqueiam ativação

A base reconciliada mantém os defeitos diagnosticados em 85fe2da: timeout com entrega pode induzir reenvio; evento interno inbound é emitido em memória pós-commit; portão obrigatório por etiqueta ainda não implementado. Os reprodutores estão preservados no scratchpad do Opus. Não é uma release pronta para WhatsApp real.

## Correções encontradas pelo portão

- Dois testes de MarIA usavam optional chaining seguido de acesso inseguro; agora falham explicitamente se a chamada esperada não existe.
- As traduções de botões/carrossel tinham chaves dinâmicas sem declaração para o extrator. Adicionadas as declarações, preservando os textos dos dois idiomas; os catálogos foram ordenados pelo próprio extrator.
- A primeira suíte completa passou 13.898 testes, pulou os seis condicionais já conhecidos e falhou na cobertura de nomes nativos: faltava migração para `send_buttons` e `send_carousel`.
- Nova `20261005180000_rename_http_tools_named_after_natives`, derivada do bloco de ferramentas customizadas da migração de setembro (arquivo histórico intacto). Renomeia colisões por tenant, preserva IDs/grants, move guidance/preconditions, registra auditoria e restaura FORCE RLS na mesma transação. Não reescreve prosa ambígua; registra prompts para revisão. Exige stop-migrate-start, ensaio e aprovação próprios em produção.
- Teste novo no PostgreSQL verifica HTTP + code, colisão entre as duas tabelas, dois tenants, ID/grants, regras, rótulo, auditoria, idempotência e RLS. Dados sintéticos preservados.
