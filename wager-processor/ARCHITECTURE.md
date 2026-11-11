# ARCHITECTURE

Este documento registra as decisões de arquitetura do **Distributed Wagering Processor**, o estado atual de cada parte e os trade-offs assumidos. Cada seção indica se o item está **implementado** ou **planejado**, para não confundir o que existe com o que ainda vai existir.

Referências no formato "README §6.3" apontam para a seção correspondente do enunciado do desafio.

**Legenda de status**

| Marca | Significado |
|---|---|
| **Implementado** | Existe no código e tem teste que passa |
| **Planejado** | Decisão tomada e justificada, código ainda não escrito |
| **A validar** | Depende de uma verificação que ainda não foi feita |

## Índice

1. Visão geral
2. Stack e justificativas
3. Decisão: MiniStack no lugar do LocalStack
4. Estrutura em camadas
5. Modelo de domínio
6. Regras de negócio (README §7)
7. Persistência e schema
8. Concorrência
9. Idempotência
10. API HTTP
11. Processamento por SQS e inbox
12. Outbox e eventos de integração
13. Workers
14. Reconciliação
15. Observabilidade
16. Estratégia de testes
17. Autenticação
18. Interpretações adotadas
19. Trade-offs e limitações conhecidas
20. Estado atual e próximos passos

---

## 1. Visão geral

O sistema processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) enviadas por múltiplos provedores, com entrega *at-least-once*. Os objetivos, em ordem de prioridade, são:

1. Saldo correto, mesmo com várias instâncias processando a mesma carteira.
2. Idempotência: reenviar a mesma transação não pode debitar ou creditar duas vezes.
3. Ledger imutável: toda mudança de saldo deixa um lançamento que não pode ser alterado.
4. Recuperação após falhas do banco, da fila e dos processos.

**Princípio central:** o banco de dados é a fonte da verdade das invariantes. Constraints, índices únicos, triggers e locks de linha garantem unicidade, imutabilidade e não-negatividade. O código de aplicação aplica as mesmas regras para dar erros claros, mas nenhuma garantia depende só dele. O broker (SQS, FIFO ou não) é tratado como otimização de ordem e entrega, nunca como garantia de consistência.

**Invariante final verificável:**

```
wallet.balance == soma assinada do ledger da wallet
```

## 2. Stack e justificativas

| Item | Escolha | Motivo |
|---|---|---|
| Runtime, package manager e test runner | Bun | Exigido pelo desafio |
| Linguagem | TypeScript em modo estrito | Exigido; ajuda a evitar erros de tipo em código financeiro |
| Framework | NestJS | Exigido; injeção de dependência e módulos |
| Banco | PostgreSQL 16 | Exigido; transações, `SELECT ... FOR UPDATE`, `SKIP LOCKED`, constraints e triggers |
| ORM | MikroORM | Preferencial no desafio; ver justificativa abaixo |
| Mensageria | AWS SQS via MiniStack | Exigido SQS local; ver seção 3 |
| Orquestração local | Docker Compose | Exigido |
| Migrations | Migrator do MikroORM, versionadas e reversíveis | Exigido; cada migration tem `up` e `down` |

**Por que MikroORM.** Unit of Work e Identity Map explícitos, `EntityManager.transactional()` e `LockMode.PESSIMISTIC_WRITE` cobrem exatamente o que o desafio pede. Também é uma ferramenta já conhecida, o que reduz risco de erro em código financeiro.

**Como o `Money` é mapeado.** O domínio não conhece o ORM. As entidades de persistência ficam em `infrastructure/` e são separadas das classes de domínio; um mapper converte entre as duas na borda:

- no banco, valor e moeda ocupam colunas separadas: `amount numeric(20,2)` e `currency char(3)`;
- a entidade MikroORM expõe `amount` como `string` (nunca `number`, para o driver não converter para ponto flutuante);
- o mapper chama `Money.from({ amount, currency })` ao ler e `money.toString()` ao gravar;
- o limite de 15 dígitos inteiros do `Money` (seção 5.1) cabe exatamente em `numeric(20,2)`.

**Estratégia transacional.** Cada requisição HTTP e cada mensagem SQS roda em um `EntityManager` próprio (`em.fork()`), com `em.transactional()` em volta do caso de uso. Nenhum `EntityManager` ou Identity Map é compartilhado entre mensagens concorrentes. Detalhes na seção 8.

**Status:** o Nest sobe no Bun e responde em `GET /health` (implementado). Postgres e MiniStack sobem pelo Docker Compose (implementado). O `GET /health` será dividido em `/health/live` e `/health/ready` (planejado, seção 15). MikroORM, migrations e o restante da stack ainda não estão ligados ao código (planejado).

## 3. Decisão: MiniStack no lugar do LocalStack

O desafio aceita LocalStack ou MiniStack. O LocalStack foi a primeira tentativa, mas a imagem `localstack/localstack` (versão 2026.10.7) encerrou com código de saída 55 e a mensagem `License activation failed`, pedindo `LOCALSTACK_AUTH_TOKEN`. Para evitar dependência de conta e token, o projeto usa a imagem `ministackorg/ministack`, que é gratuita, não exige credenciais reais e expõe a mesma porta (4566).

**Ponto a validar:** ainda não foi confirmado que o MiniStack suporta todos os atributos de filas FIFO e de DLQ (redrive). Isso será verificado em `scripts/create-queues.ts`, que cria as filas na subida do ambiente. Se faltar algo, o plano de contingência é:

- usar filas padrão (`wager-transactions` e `wager-transactions-dlq`);
- manter a ordem por carteira exclusivamente pelo lock no banco (seção 8), que já é a base da correção financeira e não depende de FIFO;
- mover para a DLQ por código (`SendMessage` na DLQ seguido de `DeleteMessage`) em vez de depender da redrive policy.

Essa contingência é viável justamente porque nenhuma invariante depende da ordem de entrega (restrição 3 do README §5).

**Status:** MiniStack e Postgres sobem e ficam saudáveis (implementado). Compatibilidade com FIFO e DLQ (a validar).

## 4. Estrutura em camadas

```
src/
  domain/          regras de negócio puras (sem Nest, sem ORM, sem SQS)
  application/     casos de uso (processar transação, criar carteira, reconciliar)
  infrastructure/  persistência (MikroORM, migrations) e SQS
  interface/       controllers HTTP e workers
  config/          variáveis de ambiente
  shared/          logger e utilitários
test/
  unit/            testes sem banco
  integration/     testes com Postgres e SQS reais
  concurrency/     testes de paralelismo real e multi-instância
scripts/           criação das filas e utilitários
```

Regra de dependência: o domínio não importa NestJS, MikroORM nem SQS. As camadas externas dependem das internas, nunca o contrário. Os casos de uso falam com o mundo externo por interfaces (portas), implementadas na infraestrutura:

| Porta (em `application/`) | Implementação (em `infrastructure/`) |
|---|---|
| `WalletRepository` | MikroORM, com `findByIdForUpdate` |
| `WagerTransactionRepository` | MikroORM |
| `LedgerRepository` | MikroORM, somente inserção e leitura |
| `InboxRepository` | MikroORM |
| `OutboxRepository` | MikroORM, com `claimDue` via `SKIP LOCKED` |
| `EventPublisher` | SQS |
| `UnitOfWork` | `em.transactional()` |
| `Clock` e `IdGenerator` | relógio do sistema e UUIDv7 (injetáveis nos testes) |
| `ProviderIdentityPort` | no-op (seção 17) |

**Status:** pastas criadas (implementado). Conteúdo atual de `domain/`:

| Arquivo | Estado |
|---|---|
| `money.ts` | Implementado e testado (seção 5.1) |
| `wager-transaction.ts` | Implementado e testado (seção 5.3) |
| `failure-code.ts` | Implementado (seção 5.3) |
| `transaction-errors.ts` | Implementado (seção 5.3) |
| `wallet.ts` | Implementado e testado (seção 5.2) |
| `ledger-entry.ts` | Implementado e testado (seção 5.4) |
| `wager-rules.ts` | Planejado (seção 6) |
| `integration-event.ts` e subclasses | Planejado (seção 12) |
| `inbox-message.ts` | Planejado (seção 5.5) |
| `outbox-message.ts` | Planejado (seção 5.5) |

Testes unitários (110 no total, todos passando com `bun test`): `test/unit/money.test.ts` (37), `test/unit/wager-transaction.test.ts` (56) e `test/unit/wallet.test.ts` (17, que cobre `Wallet` e `LedgerEntry`).

`application/`, `infrastructure/` e `interface/` ainda não têm código.

## 5. Modelo de domínio

### 5.1 Money (README §6.1)

**Status: implementado e testado** (37 testes unitários).

- **Centavos em `bigint`.** Nenhum cálculo usa `number`, então não há erro de ponto flutuante (`0.10 + 0.20` resulta exatamente em `0.30`).
- **Entrada e saída em string decimal.** A entrada aceita `"25"`, `"25.5"` e `"25.50"`; a saída (`toString` e `toJSON`) sempre tem 2 casas (`"25.00"`, `"25.50"`). Entradas com mais de 2 casas, negativas, com vírgula, em notação científica, com espaços ou que não sejam string são rejeitadas.
- **Nunca negativo.** `subtract` lança `NEGATIVE_RESULT` quando o resultado seria negativo, o que torna saldo negativo impossível por construção. A carteira ainda fará a checagem explícita.
- **Limite de 15 dígitos inteiros.** Mantém o valor dentro de `numeric(20,2)` no banco. Soma que estoura o limite lança `AMOUNT_TOO_LARGE`.
- **Imutável.** A instância é congelada (`Object.freeze`) e toda operação devolve um novo objeto.
- **Moeda validada.** Três letras maiúsculas (ex.: `BRL`). Operar moedas diferentes lança `CURRENCY_MISMATCH`.
- **Pressuposto.** Todas as moedas usadas têm 2 casas decimais.

O domínio não depende de tipos monetários do ORM: o `Money` é convertido de e para string na borda da persistência (seção 2).

### 5.2 Wallet (README §6.2)

**Status: implementado e testado** (17 testes em `test/unit/wallet.test.ts`, que também cobre o `LedgerEntry`).

A `Wallet` é o aggregate root do saldo. `debit` e `credit` recebem um `MovementInput` (id do lançamento, id da transação de origem, valor e instante opcional) e devolvem o `LedgerEntry` correspondente, de modo que saldo e ledger não divergem.

Invariantes garantidas no domínio:

- **Saldo nunca negativo.** Débito acima do saldo lança `INSUFFICIENT_FUNDS`; débito igual ao saldo é permitido e deixa o saldo em zero.
- **Valor maior que zero.** Movimentação com valor zero lança `INVALID_AMOUNT`; por isso `version` só sobe quando o saldo muda.
- **Mesma moeda.** Movimentação em moeda diferente da wallet lança `CURRENCY_MISMATCH`.
- **Tudo ou nada.** A wallet cria o lançamento primeiro e só então altera saldo, `version` e `updatedAt`. Uma movimentação rejeitada, ou um crédito que estoura o limite do `Money`, não altera nada.
- **`version` começa em 1.** `rehydrate` restaura o estado persistido sem mexer na `version`.
- **Tempo injetável.** `now` em `open` e `occurredAt` na movimentação, para testes determinísticos.

Erros: `WalletError`, com os códigos `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `INVALID_AMOUNT` e `INVALID_WALLET`.

Um teste com 2000 operações pseudoaleatórias reprodutíveis confere que o saldo final é igual à soma do ledger, que o saldo nunca ficou negativo, que a `version` subiu uma vez por movimentação aceita e que cada lançamento parte do saldo final do anterior.

Duas garantias não dependem do objeto em memória. A unicidade por `playerId` + `currency` vem de uma constraint `UNIQUE` no banco, e a proteção contra *lost update* entre instâncias vem do lock pessimista da seção 8.

### 5.3 WagerTransaction (README §6.3)

**Status: implementado e testado** (56 testes em `test/unit/wager-transaction.test.ts`: criação, transições válidas, estados terminais, regras de referência, direção no ledger e `rehydrate`).

Uma `WagerTransaction` é o registro auditável de cada transação recebida, com estado encapsulado e transições explícitas.

**Transições válidas.** A tabela vive em um único lugar do código (`ALLOWED`, em `wager-transaction.ts`):

| Estado atual | Pode ir para |
|---|---|
| `PENDING` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED` | nenhuma (terminal) |
| `REJECTED` | nenhuma (terminal) |
| `FAILED` | nenhuma (terminal) |

`PENDING_REFERENCE → PENDING_REFERENCE` é permitido porque o worker de reprocessamento tenta de novo a cada ciclo e a referência pode continuar ausente. Tentar transicionar um estado terminal lança `InvalidTransactionStateError`: é erro de programação, não caminho de negócio, e o chamador deve checar `isTerminal()` antes.

**Sobre `PENDING`.** No fluxo síncrono atual o estado `PENDING` existe só dentro da transação SQL (a linha é inserida como `PENDING` para ganhar a corrida de idempotência e já sai do commit em outro estado). Ele fica no modelo porque o README o define e porque permite aceitar uma transação para processamento posterior sem mudar o contrato.

**Regras por kind.**

- `create` nasce em `PENDING` e valida a referência: `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`; `BET`, `WIN` e `LOSS` não aceitam.
- `OPENING` é interno. `create` recusa esse kind, para que a API e a fila não consigam submiti-lo. A abertura da wallet usa `createOpening`, que já nasce `PROCESSED` na mesma transação SQL em que a wallet é criada.
- `markProcessed` exige a transação referenciada para `REFUND` e `ROLLBACK`, e a recusa para os demais kinds.
- A mesma idempotency key com payload diferente é conflito (`matchesPayload` é falso), não replay.
- `LOSS` não afeta o saldo e não gera lançamento no ledger.

**Direção no ledger** (`ledgerDirectionFor`):

| Kind | Direção |
|---|---|
| `BET` | débito |
| `WIN`, `REFUND`, `OPENING` | crédito |
| `ROLLBACK` | inverso da referência (reverter uma `BET` credita; reverter um `WIN` ou `REFUND` debita) |
| `LOSS` | não se aplica; pedir a direção lança erro |

`ROLLBACK` só aceita referência do tipo `BET`, `WIN` ou `REFUND`.

**Taxonomia de `failureCode`** (README §7.2). Todo `REJECTED` e `FAILED` carrega um código estável e legível por máquina (`failure-code.ts`). Valores publicados nunca são renomeados.

| Código | Terminal | Causa | O provedor deve |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | `REJECTED` | `BET` sem saldo | desistir ou pedir depósito |
| `REVERSAL_WOULD_OVERDRAW` | `REJECTED` | reversão deixaria o saldo negativo | escalar para a operação |
| `WALLET_NOT_FOUND` | `REJECTED` | wallet inexistente | corrigir o payload |
| `CURRENCY_MISMATCH` | `REJECTED` | moeda diferente da wallet ou da referência | corrigir o payload |
| `REFERENCE_NOT_FOUND` | `REJECTED` | referência não chegou dentro do prazo | reenviar a referência e depois a reversão |
| `REFERENCE_NOT_PROCESSED` | `REJECTED` | referência terminou `REJECTED` ou `FAILED` | desistir |
| `REFERENCE_KIND_INVALID` | `REJECTED` | `REFUND` só de `BET`; `ROLLBACK` só de `BET`, `WIN` ou `REFUND` | corrigir o payload |
| `REFERENCE_MISMATCH` | `REJECTED` | provider, player, wallet ou rodada diferem da referência | corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | `REJECTED` | valor diferente do da referência | corrigir o payload |
| `ALREADY_REVERSED` | `REJECTED` | referência já revertida | desistir |
| `INFRASTRUCTURE_ERROR` | `FAILED` | erro permanente após esgotar as tentativas | reenviar com nova chave após falar com a operação |

`INSUFFICIENT_FUNDS` e `REVERSAL_WOULD_OVERDRAW` são códigos distintos de propósito: uma aposta sem saldo e uma reversão que estouraria o saldo são situações operacionalmente diferentes (README §7, regra 9).

### 5.4 LedgerEntry (README §6.4)

**Status: implementado e testado** (4 testes próprios, mais o teste de consistência saldo x ledger, em `test/unit/wallet.test.ts`).

O README chama a classe de `WalletLedgerEntry`. No código ela se chama `LedgerEntry`, com as factories `of` (no lugar de `create`) e `opening`, e o valor do lançamento é `amount` (no lugar de `money`). Cada lançamento guarda direção (`'DEBIT'` ou `'CREDIT'`), valor, saldo antes e saldo depois.

- **Imutável.** A instância é congelada e não há métodos de transição.
- **Aritmética validada na factory.** `of` rejeita lançamento em que `balanceBefore ± amount` difere de `balanceAfter`, e rejeita valor zero, ambos com `LedgerInvariantError`.
- **Abertura.** `opening` cria o crédito que leva a wallet de 0 ao saldo inicial.
- **Valor com sinal.** `signedMinor()` devolve o valor em centavos com sinal; o teste de consistência soma o ledger com ele e compara com o saldo, e a reconciliação usa a mesma conta.

Regras que ficam na camada de aplicação (planejadas): uma transação financeira gera no máximo um lançamento por wallet, e `LOSS` e transações `REJECTED` não geram lançamento. No banco, a imutabilidade e a aritmética são reforçadas por trigger e constraints (seção 7).

### 5.5 InboxMessage e OutboxMessage (README §6.5)

**Status: planejado** (ainda sem código nem testes).

Seguem a regra de modelagem do README §6.0: construtor privado, factories estáticas e `rehydrate` que não revalida transições.

**`InboxMessage`** (`messageId`, `consumerName`, `payloadHash`, `receivedAt`, `processedAt?`):

- `receive` cria o registro; `markProcessed(at)` define `processedAt` e é idempotente só se a data for a mesma;
- `isProcessed()` consulta `processedAt`;
- a chave natural é `(consumerName, messageId)`.

**`OutboxMessage`** (`id`, `aggregateId`, `eventType`, `payload`, `occurredAt`, `attempts`, `nextAttemptAt?`, `publishedAt?`):

- `enqueue(event)` cria a mensagem pendente a partir de um `IntegrationEvent`, com `attempts = 0` e `nextAttemptAt = occurredAt`;
- `isPending()` é `publishedAt` indefinido; `isDue(now)` é pendente e `nextAttemptAt <= now`;
- `markPublished(at)` encerra a mensagem; chamar em mensagem já publicada lança erro de programação;
- `scheduleRetry(now)` incrementa `attempts` e define `nextAttemptAt = now + min(base * 2^attempts, teto)` com jitter, usando o `Clock` injetado.

Parâmetros iniciais do backoff da outbox: base de 1 s, teto de 60 s. São configuráveis por variável de ambiente.

---

## 6. Regras de negócio (README §7)

**Status: planejado.** Vai em `src/domain/wager-rules.ts`, como função pura, com testes unitários próprios.

### 6.1 Contrato do serviço de regras

Entrada: a `WagerTransaction` recém-criada, a `Wallet` (ou ausência), a transação referenciada (ou ausência) e um indicador de que a referência já foi revertida. Saída: uma de três decisões.

| Decisão | Efeito |
|---|---|
| `APPLY` | transação vai para `PROCESSED`; devolve o `LedgerEntry` (nenhum no caso de `LOSS`) e a wallet atualizada |
| `REJECT(failureCode)` | transação vai para `REJECTED`; saldo e ledger intactos |
| `WAIT_REFERENCE` | transação vai para `PENDING_REFERENCE` |

O serviço não faz I/O: quem carrega os dados e persiste o resultado é o caso de uso (seção 8).

### 6.2 Ordem das verificações

A ordem define qual `failureCode` aparece quando há mais de um problema. Ela é fixa e testada.

| # | Verificação | Resultado |
|---|---|---|
| 1 | Wallet não existe | `REJECT WALLET_NOT_FOUND` |
| 2 | Moeda da transação difere da moeda da wallet | `REJECT CURRENCY_MISMATCH` |
| 3 | `REFUND` ou `ROLLBACK` sem a referência carregada | `WAIT_REFERENCE` |
| 4 | Tipo da referência inválido (`REFUND` só de `BET`; `ROLLBACK` só de `BET`, `WIN` ou `REFUND`) | `REJECT REFERENCE_KIND_INVALID` |
| 5 | Referência ainda não terminal (`PENDING` ou `PENDING_REFERENCE`) | `WAIT_REFERENCE` |
| 6 | Referência terminou `REJECTED` ou `FAILED` | `REJECT REFERENCE_NOT_PROCESSED` |
| 7 | Provider, player, wallet ou rodada diferem da referência | `REJECT REFERENCE_MISMATCH` |
| 8 | Moeda difere da referência | `REJECT CURRENCY_MISMATCH` |
| 9 | Valor difere do da referência | `REJECT REFERENCE_AMOUNT_MISMATCH` |
| 10 | Referência já revertida | `REJECT ALREADY_REVERSED` |
| 11 | Aplicar o movimento: `BET` debita, `WIN` e `REFUND` creditam, `ROLLBACK` usa o inverso da referência, `LOSS` não gera lançamento | `APPLY` |
| 12 | O débito falha por saldo | `REJECT INSUFFICIENT_FUNDS` (`BET`) ou `REJECT REVERSAL_WOULD_OVERDRAW` (`ROLLBACK`) |

### 6.3 Referências fora de ordem (README §7.1)

Uma reversão pode chegar antes da referência. Nesse caso a transação é persistida como `PENDING_REFERENCE` e reprocessada por um worker agendado (seção 13).

- **Backoff:** exponencial, com base de 10 s e fator 2 (10 s, 20 s, 40 s, 80 s, 160 s), teto de 5 minutos por intervalo.
- **Limite:** 5 tentativas, ou cerca de 5 minutos no total. Parâmetros configuráveis (`PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_BASE_DELAY_MS`).
- **Justificativa:** a referência atrasada tipicamente chega em segundos, por reentrega ou por outra instância do provedor. Cinco minutos cobrem esse caso sem deixar transações penduradas por horas. Além disso, o provedor tem um código claro (`REFERENCE_NOT_FOUND`) para reenviar a referência e depois a reversão.
- **Esgotado o limite:** `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected` publicado.

### 6.4 Reversões

Uma mesma referência só pode ser revertida uma vez. O README é ambíguo sobre um `REFUND` e um `ROLLBACK` na mesma `BET` (regra 4: "pelo mesmo tipo de operação"); a decisão é **bloquear os dois**, porque permitir ambos creditaria o valor duas vezes e violaria a invariante de não duplicar créditos. A regra é reforçada no banco com um índice único parcial (seção 7). Um `ROLLBACK` sobre um `REFUND` aponta para outra referência (o próprio `REFUND`) e continua permitido.

---

## 7. Persistência e schema

**Status: planejado.** As garantias de unicidade, imutabilidade e não-negatividade ficam no schema, conforme a restrição 9 do README §5. As migrations são versionadas, cada uma com `up` e `down`, e rodam com `bun run migration:up` e `bun run migration:down`.

### 7.1 Tabelas

```sql
wallets (
  id            uuid PRIMARY KEY,
  player_id     uuid NOT NULL,
  currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance       numeric(20,2) NOT NULL CHECK (balance >= 0),
  version       integer NOT NULL CHECK (version >= 1),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  UNIQUE (player_id, currency)
)

wager_transactions (
  id                                uuid PRIMARY KEY,
  seq                               bigint GENERATED ALWAYS AS IDENTITY,
  provider_id                       text NOT NULL,
  external_transaction_id           text NOT NULL,
  idempotency_key                   text NOT NULL,
  payload_hash                      char(64) NOT NULL,
  wallet_id                         uuid NOT NULL REFERENCES wallets(id),
  player_id                         uuid NOT NULL,
  round_id                          text NOT NULL,
  game_id                           text NOT NULL,
  kind                              text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                            numeric(20,2) NOT NULL CHECK (amount > 0),
  currency                          char(3) NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid REFERENCES wager_transactions(id),
  status                            text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                      text,
  balance_after                     numeric(20,2),   -- saldo observado ao processar (usado no replay)
  pending_attempts                  integer NOT NULL DEFAULT 0,
  next_attempt_at                   timestamptz,
  created_at                        timestamptz NOT NULL,
  processed_at                      timestamptz,
  UNIQUE (idempotency_key),
  UNIQUE (provider_id, external_transaction_id),
  CHECK ((kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)),
  CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL))
)

wallet_ledger_entries (
  id               uuid PRIMARY KEY,
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  wallet_id        uuid NOT NULL REFERENCES wallets(id),
  transaction_id   uuid NOT NULL REFERENCES wager_transactions(id),
  direction        text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount           numeric(20,2) NOT NULL CHECK (amount > 0),
  currency         char(3) NOT NULL,
  balance_before   numeric(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after    numeric(20,2) NOT NULL CHECK (balance_after >= 0),
  created_at       timestamptz NOT NULL,
  UNIQUE (transaction_id, wallet_id),
  CHECK ((direction = 'CREDIT' AND balance_before + amount = balance_after)
      OR (direction = 'DEBIT'  AND balance_before - amount = balance_after))
)

inbox_messages (
  consumer_name  text NOT NULL,
  message_id     text NOT NULL,
  payload_hash   char(64) NOT NULL,
  received_at    timestamptz NOT NULL,
  processed_at   timestamptz,
  PRIMARY KEY (consumer_name, message_id)
)

outbox_messages (
  id               uuid PRIMARY KEY,
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  aggregate_id     uuid NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  published_at     timestamptz
)
```

### 7.2 Índices

```sql
-- uma referência só pode ser revertida uma vez (seção 6.4)
CREATE UNIQUE INDEX uq_reversal_per_reference
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';

-- worker de PENDING_REFERENCE
CREATE INDEX ix_pending_reference_due
  ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

-- worker de outbox
CREATE INDEX ix_outbox_due
  ON outbox_messages (next_attempt_at, seq)
  WHERE published_at IS NULL;

-- paginação do ledger e resolução de referência
CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);
CREATE INDEX ix_wager_reference_lookup
  ON wager_transactions (provider_id, external_transaction_id);  -- já coberto pelo UNIQUE
```

### 7.3 Imutabilidade do ledger

Um trigger bloqueia `UPDATE` e `DELETE` em `wallet_ledger_entries`, e um segundo trigger de nível de comando bloqueia `TRUNCATE`:

```sql
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
```

Assim a imutabilidade vale mesmo para quem acessa o banco sem passar pela aplicação. O usuário de banco da aplicação também não recebe `UPDATE`, `DELETE` nem `TRUNCATE` nessa tabela (defesa em profundidade). Um teste de integração tenta cada uma dessas operações e espera erro.

### 7.4 O que cada constraint protege

| Garantia | Mecanismo |
|---|---|
| Uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única por referência | índice único parcial `uq_reversal_per_reference` |
| Um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| Aritmética do lançamento | `CHECK` com `balance_before ± amount = balance_after` |
| Ledger imutável | triggers e privilégios |
| Deduplicação de mensagens SQS | `PRIMARY KEY (consumer_name, message_id)` |
| `REFUND`/`ROLLBACK` com referência e demais sem | `CHECK` em `wager_transactions` |

---

## 8. Concorrência

**Status: planejado.**

A unidade de concorrência é a `walletId` (README §8). A estratégia é **lock pessimista por carteira**: `SELECT ... FOR UPDATE` na linha da wallet, dentro de uma transação, via `LockMode.PESSIMISTIC_WRITE` do MikroORM. Combinada com **optimistic locking como segunda barreira**: o `UPDATE` do saldo é condicionado à versão lida (`WHERE id = :id AND version = :version`) e o `CHECK (balance >= 0)` do banco é a terceira.

### 8.1 Por que lock pessimista

- Serializa as operações da mesma carteira entre qualquer número de instâncias, sem depender de memória do processo (restrição 8).
- Não é lock global: cada wallet tem a sua linha, então wallets diferentes processam em paralelo (restrição 6).
- Não é `read → calculate → update` sem controle (restrição 7): o saldo lido já está travado.
- Com optimistic locking puro, uma wallet quente (muitas apostas simultâneas) geraria uma tempestade de conflitos e retries. O lock enfileira as operações no banco, que é o lugar mais barato para isso.
- As reversões referenciam sempre a mesma wallet da referência (regra 2 do README §7). Logo, o lock da wallet também serializa a checagem de "já revertida", e o índice parcial é só o backstop.

### 8.2 Fluxo do caso de uso

O mesmo caso de uso (`ProcessWagerTransaction`) atende a entrada HTTP e o consumidor SQS:

```
BEGIN
 1. (SQS) INSERT em inbox ON CONFLICT DO NOTHING
        conflito -> mensagem repetida: não processa de novo (seção 11)
 2. INSERT em wager_transactions (PENDING) ON CONFLICT (idempotency_key) DO NOTHING
        conflito -> comparar payload_hash: igual = replay, diferente = conflito (seção 9)
 3. SELECT wallet ... FOR UPDATE                 (lock por wallet)
 4. carregar a referência por (provider_id, reference_external_transaction_id)
    e checar se já foi revertida
 5. WagerRules.decide(transação, wallet, referência, jáRevertida)
 6. APPLY:  INSERT no ledger
            UPDATE wallets SET balance, version = version + 1, updated_at
                   WHERE id = :id AND version = :versionLida
    REJECT / WAIT_REFERENCE: nenhuma mudança de saldo
 7. UPDATE wager_transactions (status, failure_code, reference_transaction_id,
                               balance_after, processed_at, pending_attempts)
 8. INSERT em outbox_messages (eventos da seção 12)
 9. (SQS) marcar inbox como processada
COMMIT
depois do commit: ack do SQS ou resposta HTTP
```

Pontos importantes:

- **Nenhum I/O externo dentro da transação.** A publicação no SQS acontece depois, pelo worker de outbox. Isso mantém o lock curto e atende a restrição 4 (não publicar antes do commit).
- **Sem deadlock por construção.** Cada transação trava no máximo uma wallet, e o único outro ponto de espera é o índice único da idempotência, que não forma ciclo com o lock da wallet.
- **`lock_timeout` curto** (`SET LOCAL lock_timeout = '5s'`). Estourar o prazo vira erro transitório (503 na API, retry com backoff no SQS) e incrementa a métrica de conflitos de lock.
- **Se a versão não bater** no `UPDATE` do passo 6 (não deveria ocorrer com o lock, mas protege contra bug), a transação aborta com erro transitório e a mensagem é reprocessada.
- **Um `EntityManager` por unidade de trabalho** (`em.fork()`), para que o Identity Map nunca guarde uma wallet lida por outra mensagem.

### 8.3 Cenário obrigatório (README §8)

Saldo `100.00`, duas apostas de `80.00` simultâneas. A primeira a obter o lock da wallet vê saldo 100, debita e confirma (saldo 20). A segunda espera o lock, lê saldo 20 e é rejeitada com `INSUFFICIENT_FUNDS`. Resultado: uma `PROCESSED`, uma `REJECTED`, saldo final `20.00`, um único lançamento de débito. Reenvios de qualquer uma delas são replays e não duplicam o débito.

### 8.4 Multi-instância

A aplicação não guarda estado de correção em memória. Locks, idempotência, inbox e outbox vivem no Postgres, então qualquer número de instâncias é seguro. Os testes de concorrência sobem pelo menos 3 processos da aplicação contra o mesmo banco (seção 16). Os workers também são seguros em várias instâncias (seção 13).

---

## 9. Idempotência

**Status: planejado.** Persistida no banco; nenhum cache em memória é usado como garantia (restrição 2).

### 9.1 Chaves

- O header `Idempotency-Key` é obrigatório na API e é a fonte da verdade. Na fila, vale o campo `data.idempotencyKey`.
- Valor recomendado: `"{providerId}:{externalTransactionId}"`.
- A chave tem `UNIQUE` no banco. Além dela, `(provider_id, external_transaction_id)` também é `UNIQUE`: mesma transação externa com chave diferente é conflito (`409`), não uma nova operação.

### 9.2 `payloadHash`

SHA-256, em hexadecimal minúsculo, de um **JSON canônico** do subconjunto de campos de negócio:

```
providerId, externalTransactionId, playerId, walletId, roundId, gameId,
kind, money { amount, currency }, referenceExternalTransactionId (omitido se ausente)
```

Regras da canonicalização:

1. chaves de objeto em ordem lexicográfica, em todos os níveis;
2. sem espaços nem quebras de linha;
3. UTF-8;
4. `amount` normalizado com 2 casas (`"25"`, `"25.5"` e `"25.50"` geram o mesmo hash);
5. o header `Idempotency-Key`, `messageId`, `occurredAt` e qualquer metadado de transporte **não** entram no hash.

### 9.3 Comportamento

| Situação | Resultado |
|---|---|
| Chave nova | processa e grava o resultado |
| Mesma chave, mesmo hash | **replay**: devolve o resultado original (status, `failureCode` e o saldo observado na época, guardado em `balance_after`), com `idempotentReplay: true` |
| Mesma chave, hash diferente | **conflito**: `409`, nada é processado |
| Mesma `(provider, externalTransactionId)` com chave diferente | **conflito**: `409` |
| 50 requisições iguais em paralelo | o `INSERT ... ON CONFLICT DO NOTHING` serializa pelo índice único: uma processa, as outras esperam o commit dela e viram replay |

O replay devolve o saldo observado no processamento original, e não o saldo atual da wallet, para que o resultado seja realmente o mesmo (README §7, regra 7).

---

## 10. API HTTP

**Status: planejado.** Apenas `GET /health` existe hoje.

### 10.1 Endpoints

| Método e rota | Função |
|---|---|
| `POST /wallets` | cria wallet; saldo inicial maior que zero gera `OPENING` e o crédito de abertura na mesma transação SQL |
| `GET /wallets/:walletId` | consulta saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado por cursor |
| `POST /wagering/transactions` | submete transação (exige `Idempotency-Key`) |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `POST /wallets/:walletId/reconciliation` | reconciliação (seção 14) |
| `GET /health/live` e `GET /health/ready` | health checks, sem autenticação |
| `GET /metrics` | métricas Prometheus |

O formato dos corpos segue o README §9. O `Money` trafega sempre como `{ "amount": "25.00", "currency": "BRL" }`.

### 10.2 Mapeamento de status HTTP

O mapeamento é o mesmo em todos os endpoints, e cada erro traz um corpo estável com `code`, `message` e `retryable`, para o provedor decidir sem interpretar texto:

| Situação | HTTP | `retryable` |
|---|---|---|
| Payload inválido (validação, `OPENING` submetido, header ausente) | `400` | não |
| Recurso não encontrado (consultas) | `404` | não |
| Conflito de idempotência ou wallet duplicada | `409` | não |
| Rejeição por regra de negócio (`REJECTED`, com `failureCode`) | `422` | depende do `failureCode` (tabela da seção 5.3) |
| Aceita com processamento pendente (`PENDING_REFERENCE`) | `202` | consultar depois |
| Processada pela primeira vez | `201` | n/a |
| Replay de transação `PROCESSED` | `200` | n/a |
| Replay de transação `REJECTED` | `422` com `idempotentReplay: true` | igual ao original |
| Falha transitória de infraestrutura (banco indisponível, `lock_timeout`) | `503` com `Retry-After` | **sim, com a mesma chave** |
| Erro inesperado | `500` | sim, com a mesma chave |

Como a chave de idempotência é persistida, reenviar após `503` ou `500` é sempre seguro.

### 10.3 Paginação do ledger

O cursor é opaco (base64url de `{ "seq": n }`) e ordena por `seq`, uma coluna identity. Como as inserções no ledger de uma wallet acontecem sob o lock dessa wallet, `seq` é monotônico por wallet, o que torna o cursor estável mesmo com escritas concorrentes.

---

## 11. Processamento por SQS e inbox

**Status: planejado.** Depende da validação da seção 3.

### 11.1 Filas

```
wager-transactions.fifo        entrada (MessageGroupId = walletId, MessageDeduplicationId = messageId)
wager-transactions-dlq.fifo    mensagens mortas (redrive após maxReceiveCount)
```

O `MessageGroupId` por wallet reduz disputa de lock, e a deduplicação do SQS reduz duplicatas. Ambos são **otimização**: a correção vem do inbox, da idempotência e do lock (restrição 3).

### 11.2 Consumidor

O consumidor usa o mesmo caso de uso da API, com long polling e concorrência limitada. Sequência por mensagem:

1. valida o envelope e o payload (erro aqui é **permanente**);
2. chama `ProcessWagerTransaction` (seção 8), que grava o inbox na mesma transação;
3. só depois do commit, apaga a mensagem da fila (`DeleteMessage`).

### 11.3 Inbox

`(consumer_name, message_id)` é a chave primária. Se a mensagem já foi processada (por exemplo, o processo morreu depois do commit e antes do ack), a reentrega encontra o inbox, não reaplica nada e apenas confirma o ack. Mesmo `messageId` com `payloadHash` diferente é erro **permanente**.

### 11.4 Classificação de erros

| Tipo | Exemplos | Ação |
|---|---|---|
| **Negócio** (terminal) | saldo insuficiente, referência inválida | a transação já foi gravada como `REJECTED`; **ack** |
| **Transitório** | banco indisponível, `lock_timeout`, timeout | não apaga; `ChangeMessageVisibility` com backoff exponencial; reentrega |
| **Permanente** | payload inválido, `OPENING` submetido, conflito de idempotência, `messageId` com hash diferente | vai para a **DLQ** |

Esgotado o limite de recebimentos (`ApproximateReceiveCount` acima de `SQS_MAX_RECEIVE_COUNT`, padrão 5), a mensagem vai para a DLQ. Quando o payload é válido, o consumidor tenta antes gravar a transação como `FAILED` com `INFRASTRUCTURE_ERROR`, em uma transação própria, para deixar rastro auditável. Se o banco ainda estiver fora, só a mensagem na DLQ serve de registro (limitação documentada na seção 19).

### 11.5 Encerramento (`SIGTERM`)

O consumidor para de fazer polling, espera as mensagens em andamento terminarem (com timeout configurável) e, para as que não terminarem a tempo, devolve a visibilidade (`ChangeMessageVisibility` com 0) para outra instância assumir. O Nest usa `enableShutdownHooks()`.

---

## 12. Outbox e eventos de integração

**Status: planejado.**

### 12.1 Atomicidade

Transação, saldo, lançamento, inbox e eventos de integração são gravados na **mesma transação SQL** (seção 8). Ou tudo é confirmado junto, ou nada. Nenhum evento é publicado antes do commit (restrição 4).

### 12.2 Eventos mínimos

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` e `OPENING` |
| `WagerTransactionRejected` | transação rejeitada por regra de negócio (inclui `REFERENCE_NOT_FOUND` ao esgotar o prazo) |
| `WalletBalanceChanged` | **somente** quando o saldo muda (`LOSS` e rejeições não geram) |
| `WagerTransactionPendingReference` | na primeira vez que a transação entra em `PENDING_REFERENCE` (as tentativas seguintes não geram novo evento, para não inundar a fila) |

O envelope é a classe abstrata `IntegrationEvent<T>`, com `eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`, `eventType` e `version` fixados no tipo de cada subclasse concreta. O `data` carrega `MoneyProps` (string decimal), nunca a instância de `Money`, para o payload ser JSON estável e versionável. `correlationId` vem da requisição ou da mensagem de origem, e `causationId` é o id da transação.

### 12.3 Worker de publicação

Vários publishers podem rodar ao mesmo tempo sem perder nem duplicar indefinidamente:

```
BEGIN
  SELECT ... FROM outbox_messages
   WHERE published_at IS NULL AND next_attempt_at <= now()
   ORDER BY next_attempt_at, seq
   LIMIT :lote
   FOR UPDATE SKIP LOCKED
  para cada mensagem: publica no SQS
     sucesso -> published_at = now()
     falha   -> attempts + 1, next_attempt_at com backoff (scheduleRetry)
COMMIT
```

`SKIP LOCKED` faz cada publisher pegar um lote disjunto. Eventos publicados vão para a fila `wager-events` com o `eventId` como identificador.

### 12.4 Cenário de crash (README §11)

1. O Postgres confirma o commit (a outbox já tem o evento).
2. O processo morre antes de publicar.
3. Outra instância pega a linha pendente no próximo ciclo.
4. O evento é publicado.
5. Se um publisher morre **depois** de publicar e **antes** de marcar `published_at`, o evento é publicado de novo. A garantia é *at-least-once*: o consumidor deduplica por `eventId` (para ele, uma publicação duplicada é segura).

---

## 13. Workers

**Status: planejado.** Ambos são seguros em várias instâncias.

| Worker | Função | Como evita conflito |
|---|---|---|
| Outbox publisher | publica eventos pendentes (seção 12.3) | `FOR UPDATE SKIP LOCKED` |
| Reprocessador de `PENDING_REFERENCE` | reexecuta o caso de uso para transações cuja `next_attempt_at` venceu | `SKIP LOCKED` na seleção e, no processamento, o mesmo lock por wallet do caso de uso |

O reprocessador reutiliza `ProcessWagerTransaction`, então as regras são as mesmas da entrada normal. A cada tentativa frustrada ele incrementa `pending_attempts` e calcula `next_attempt_at` pelo backoff da seção 6.3. Ao esgotar o limite, rejeita com `REFERENCE_NOT_FOUND`.

Os intervalos de polling dos workers são configuráveis. Ao reiniciar, nada se perde: o estado está nas tabelas (`published_at` nulo e `status = 'PENDING_REFERENCE'`).

---

## 14. Reconciliação

**Status: planejado.**

`POST /wallets/:walletId/reconciliation` compara o saldo materializado com o saldo reconstruído pelo ledger:

```sql
SELECT w.balance AS stored,
       COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS calculated,
       COUNT(l.id) AS checked_entries
  FROM wallets w
  LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
 WHERE w.id = :walletId
 GROUP BY w.id;
```

A leitura roda em uma única transação `REPEATABLE READ`, para o saldo e o ledger virem do mesmo snapshot, mesmo com escritas concorrentes. A resposta segue o formato do README §9 (`storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`).

**Divergências não são corrigidas silenciosamente.** Quando `consistent` é falso, o sistema registra um log de nível `error`, incrementa a métrica `reconciliation_divergences_total` e sinaliza na resposta. Corrigir é decisão humana.

---

## 15. Observabilidade

**Status: planejado.**

### 15.1 Logs

JSON estruturado (pino). Todo log carrega, quando existirem, `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. O `correlationId` é propagado por `AsyncLocalStorage`. Os logs **não** carregam payloads financeiros completos: registram identificadores e status, e valores monetários só em campos explicitamente permitidos, nunca o corpo inteiro. Cabeçalhos e dados pessoais passam por redação.

### 15.2 Métricas

Expostas em `/metrics` (formato Prometheus, `prom-client`):

| Métrica | Tipo | Rótulos |
|---|---|---|
| `wager_transactions_total` | counter | `kind`, `status`, `failure_code` |
| `wager_duplicates_total` | counter | `source` (`http` ou `sqs`) |
| `wager_retries_total` | counter | `source`, `reason` |
| `wager_dlq_messages_total` | counter | `reason` |
| `wallet_lock_conflicts_total` | counter | `kind` (`lock_timeout` ou `version_mismatch`) |
| `outbox_lag_seconds` | gauge | idade do evento pendente mais antigo |
| `outbox_published_total` | counter | `event_type` |
| `wager_processing_duration_seconds` | histogram | `kind`, `source` |
| `reconciliation_divergences_total` | counter | n/a |

### 15.3 Health checks

- `GET /health/live`: o processo está vivo (não consulta dependências).
- `GET /health/ready`: Postgres e SQS respondem. Retorna `503` se qualquer um falhar.

Ambos ficam abertos, sem autenticação. OpenTelemetry e dashboard são opcionais e não estão no escopo.

---

## 16. Estratégia de testes

**Status:** unidade **implementada** para o domínio atual (110 testes, `bun test`). Regras da seção 6, inbox, outbox, integração e concorrência são **planejados**.

### 16.1 Unidade (sem banco)

- `Money`: escala, arredondamento, entradas inválidas, moedas diferentes (implementado).
- `Wallet` e `LedgerEntry`: invariantes e consistência saldo x ledger (implementado).
- `WagerTransaction`: transições, referências, direção no ledger (implementado).
- `WagerRules`: um caso feliz por kind, cada linha da tabela 6.2, o cenário 100/80/80, reversões que estouram o saldo, `REFUND` e `ROLLBACK` na mesma `BET` (planejado).
- `payloadHash` canônico e conflito de idempotency key com payload divergente (planejado).
- `InboxMessage` e `OutboxMessage`, incluindo o backoff (planejado).

### 16.2 Integração (Postgres e MiniStack reais)

Sem mocks de banco ou de fila. Cobrem: migrations (`up` e `down`) e constraints; atomicidade entre wallet, ledger, inbox e outbox; imutabilidade do ledger (`UPDATE`, `DELETE` e `TRUNCATE` falham); inbox e redelivery; publishers concorrentes sobre a mesma outbox; retry e DLQ; recuperação após reinicialização.

### 16.3 Concorrência (paralelismo real)

Os cenários do README §13, rodando em processos separados sempre que o cenário exigir:

1. a mesma aposta enviada 50 vezes em paralelo resulta em um único débito;
2. disputa pelo saldo da mesma wallet (cenário 100/80/80);
3. wallets distintas processadas em paralelo;
4. pelo menos 3 instâncias da aplicação simultâneas;
5. worker morto depois do commit e antes do ack;
6. dois publishers sobre a mesma outbox;
7. `ROLLBACK` ou `REFUND` entregue antes da referência;
8. reinício do serviço com comprovação da consistência final.

**Invariante final de todos os testes:** `wallet.balance == saldo reconstruído pelo ledger`.

### 16.4 Comandos

```
bun test test/unit            # unidade
bun run test:integration      # exige docker compose up (Postgres e MiniStack)
bun run test:concurrency      # exige docker compose up e sobe múltiplas instâncias
bun run test:load             # opcional (diferencial)
```

Testes determinísticos: `Clock` e `IdGenerator` injetados, dados pseudoaleatórios com semente fixa.

---

## 17. Autenticação

**Status: não implementada, por decisão.** O README (§2) informa que autenticação não vale pontos e deve ser dimensionada para não competir com correção financeira, concorrência e idempotência. A decisão é **não implementar**, mantendo o ponto de extensão explícito.

**Ponto de extensão no código:** um `AuthGuard` global no-op (aprova tudo) e uma porta `ProviderIdentityPort`, com a implementação atual devolvendo "provedor não verificado". Trocar a implementação não exige mudar casos de uso.

**Desenho que seria adotado:**

- Identity Provider externo (Keycloak, com OIDC), nunca tabela própria de usuários nem hash de senha.
- Provedores de jogos usam *client credentials*; o `AuthGuard` valida o JWT pela JWKS do IdP (assinatura, `iss`, `aud`, expiração).
- Uma claim identifica o `providerId` do chamador. O caso de uso rejeita (`403`) quando o `providerId` do corpo difere do da claim, impedindo um provedor de operar em nome de outro.
- Rotas administrativas (`reconciliation`, consultas de wallet) exigiriam um papel próprio.

**Escopo que a autenticação não cobre:** os endpoints de health ficam abertos, e mensagens vindas da fila são tratadas como canal interno confiável. A identidade do provedor contida na mensagem continua sujeita às mesmas validações de domínio (wallet, player, moeda, rodada e referência).

---

## 18. Interpretações adotadas

Pontos em que o README é ambíguo ou deixa a decisão em aberto, e o que foi decidido:

| Tema | Decisão |
|---|---|
| `REFUND` e `ROLLBACK` na mesma `BET` | Bloquear o segundo, pois creditaria o valor duas vezes (seção 6.4) |
| `ROLLBACK` sobre um `REFUND` | Permitido: a referência é o `REFUND`, e não a `BET` |
| Referência ainda não terminal (`PENDING` ou `PENDING_REFERENCE`) | Aguardar (`WAIT_REFERENCE`), não rejeitar |
| Referência `REJECTED` ou `FAILED` | Rejeitar com `REFERENCE_NOT_PROCESSED` |
| `LOSS` | Registrada como `PROCESSED`, sem ledger e sem `WalletBalanceChanged` |
| `OPENING` | Gera `WagerTransactionProcessed` e `WalletBalanceChanged` |
| Reversão que estouraria o saldo | `REVERSAL_WOULD_OVERDRAW`, distinto de `INSUFFICIENT_FUNDS` |
| Mesma `(provider, externalTransactionId)` com chave diferente | Conflito `409` |
| Limite do `PENDING_REFERENCE` | 5 tentativas, backoff exponencial de 10 s com teto de 5 min (seção 6.3) |
| Moeda | Modelo multi-moeda, mas todas com 2 casas decimais; testes de conflito de moeda cobrem a troca |
| Valor da reversão | Sempre igual ao da referência; reversão parcial fora de escopo |
| Ledger | Lançamento simples (uma entrada por transação); partidas dobradas é diferencial não implementado |

---

## 19. Trade-offs e limitações conhecidas

- **Wallet quente.** O lock por carteira serializa as operações da mesma wallet. É o preço de uma correção simples e robusta. A vazão por wallet é limitada pelo tempo de hold do lock, mantido curto por não haver I/O externo dentro da transação. Wallets diferentes escalam em paralelo.
- **Entrega *at-least-once* na saída.** A outbox pode publicar um evento mais de uma vez; a deduplicação é responsabilidade do consumidor, por `eventId`.
- **`FAILED` depende do banco.** Se o banco estiver fora quando as tentativas se esgotam, não há como gravar `FAILED`; a mensagem na DLQ passa a ser o único registro.
- **Compatibilidade do MiniStack com FIFO e DLQ ainda não verificada** (seção 3). A contingência com filas padrão mantém a correção, mas perde a ordenação por grupo como otimização.
- **Reconciliação é O(n)** no tamanho do ledger da wallet. Para volumes grandes seriam necessários *checkpoints* de saldo.
- **Crescimento do ledger e da outbox.** Sem particionamento nem rotina de arquivamento neste escopo.
- **Sem autenticação** (seção 17) e sem rate limiting.
- **Uma única moeda de fato nos testes**, com 2 casas decimais (pressuposto do `Money`).
- **Sem partidas dobradas** e sem reversão parcial.
- **Sem OpenTelemetry** nem dashboard.
- **Teste de carga** (`bun run test:load`) é um diferencial opcional e não está no escopo inicial. Se for feito, registrará ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e lag da outbox.

---

## 20. Estado atual e próximos passos

**Concluído**

- Nest sobe no Bun e responde em `GET /health`; Postgres e MiniStack sobem pelo Docker Compose.
- Domínio: `Money`, `Wallet`, `LedgerEntry`, `WagerTransaction`, `failure-code` e `transaction-errors`, com 110 testes unitários passando.

**Próximos passos, em ordem**

1. **Domínio restante:** `WagerRules` (seção 6), `IntegrationEvent` e as 4 subclasses, `InboxMessage` e `OutboxMessage`, com testes.
2. **Persistência:** entidades MikroORM e mapper do `Money`, migrations com as constraints, triggers e índices da seção 7.
3. **Casos de uso:** criar wallet, processar transação, consultas e reconciliação.
4. **Interface:** controllers HTTP, mapeamento de erros, consumidor SQS, workers, health checks, logs e métricas.
5. **Validar MiniStack** com FIFO e DLQ ao criar as filas (seção 3).
6. **Testes** de integração e de concorrência (seção 16).
7. **Documentação:** `README.md` com setup e comandos, e este documento atualizado a cada etapa concluída.