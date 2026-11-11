# ARCHITECTURE

Este documento registra as decisões de arquitetura do **Distributed Wagering Processor** e o estado atual de cada parte. Cada seção indica se o item está **implementado** ou **planejado**, para não confundir o que existe com o que ainda vai existir.

## 1. Visão geral

O sistema processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) enviadas por múltiplos provedores, com entrega *at-least-once*. Os objetivos, em ordem de prioridade, são:

1. Saldo correto, mesmo com várias instâncias processando a mesma carteira.
2. Idempotência: reenviar a mesma transação não pode debitar ou creditar duas vezes.
3. Ledger imutável: toda mudança de saldo deixa um lançamento que não pode ser alterado.
4. Recuperação após falhas do banco, da fila e dos processos.

## 2. Stack e justificativas

| Item | Escolha | Motivo |
|---|---|---|
| Runtime, package manager e test runner | Bun | Exigido pelo desafio |
| Linguagem | TypeScript em modo estrito | Exigido; ajuda a evitar erros de tipo em código financeiro |
| Framework | NestJS | Exigido; injeção de dependência e módulos |
| Banco | PostgreSQL 16 | Exigido; garante transações, `SELECT ... FOR UPDATE` e constraints |
| ORM | MikroORM | Permitido pelo desafio; escolhido por já ser conhecido |
| Mensageria | AWS SQS via MiniStack | Exigido SQS local; ver decisão na seção 3 |
| Orquestração local | Docker Compose | Exigido |

**Status:** o Nest sobe no Bun e responde em `GET /health` (implementado). Postgres e MiniStack sobem pelo Docker Compose (implementado).

## 3. Decisão: MiniStack no lugar do LocalStack

O desafio aceita LocalStack ou MiniStack. O LocalStack foi a primeira tentativa, mas a imagem `localstack/localstack` (versão 2026.10.7) encerrou com código de saída 55 e a mensagem `License activation failed`, pedindo `LOCALSTACK_AUTH_TOKEN`. Para evitar dependência de conta e token, o projeto usa a imagem `ministackorg/ministack`, que é gratuita, não exige credenciais reais e expõe a mesma porta (4566).

**Ponto a validar:** ainda não foi confirmado que o MiniStack suporta todos os atributos de filas FIFO e de DLQ (redrive). Isso será verificado ao criar as filas. Se faltar algo, a alternativa é usar filas padrão e garantir a ordem por carteira com o lock no banco, que já é a base da correção financeira.

**Status:** MiniStack e Postgres sobem e ficam saudáveis (implementado). Compatibilidade com FIFO e DLQ (pendente de verificação).

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
scripts/           criação das filas e utilitários
```

Regra de dependência: o domínio não importa NestJS, MikroORM nem SQS. As camadas externas dependem das internas, nunca o contrário. Os casos de uso falam com o mundo externo por interfaces (portas), implementadas na infraestrutura.

**Status:** pastas criadas (implementado). Apenas `domain/money.ts` tem código até agora.

## 5. Modelo de dinheiro (`Money`)

**Status: implementado e testado** (37 testes unitários).

- **Centavos em `bigint`.** Nenhum cálculo usa `number`, então não há erro de ponto flutuante (`0.10 + 0.20` resulta exatamente em `0.30`).
- **Entrada e saída em string decimal.** A entrada aceita `"25"`, `"25.5"` e `"25.50"`; a saída (`toString` e `toJSON`) sempre tem 2 casas (`"25.00"`, `"25.50"`). Entradas com mais de 2 casas, negativas, com vírgula, em notação científica, com espaços ou que não sejam string são rejeitadas.
- **Nunca negativo.** `subtract` lança `NEGATIVE_RESULT` quando o resultado seria negativo, o que torna saldo negativo impossível por construção. A carteira ainda fará a checagem explícita.
- **Limite de 15 dígitos inteiros.** Mantém o valor dentro de `numeric(20,2)` no banco. Soma que estoura o limite lança `AMOUNT_TOO_LARGE`.
- **Imutável.** A instância é congelada (`Object.freeze`) e toda operação devolve um novo objeto.
- **Moeda validada.** Três letras maiúsculas (ex.: `BRL`). Operar moedas diferentes lança `CURRENCY_MISMATCH`.
- **Pressuposto.** Todas as moedas usadas têm 2 casas decimais.

O domínio não depende de tipos monetários do ORM: o `Money` é convertido de e para string na borda da persistência.

## 6. Decisões planejadas (ainda não implementadas)

### 6.1 Concorrência
Lock pessimista por carteira com `SELECT ... FOR UPDATE` dentro de uma transação. Isso serializa as operações da mesma carteira entre várias instâncias da aplicação, sem depender de memória do processo. O banco também terá `CHECK (balance >= 0)` como segunda barreira.

### 6.2 Idempotência
A idempotência será persistida no banco, com `UNIQUE` em `idempotency_key` e em `(provider_id, external_transaction_id)`. Cada transação guarda um hash do payload: a mesma chave com payload diferente é conflito (HTTP 409), e a mesma chave com o mesmo payload devolve o resultado original, incluindo o saldo observado na época do processamento.

### 6.3 Ledger imutável
Toda mudança de saldo gera um lançamento no ledger, com direção, valor, saldo antes e saldo depois. Um trigger no banco bloqueará `UPDATE` e `DELETE` nessa tabela.

### 6.4 Reversões (interpretação do README)
Uma mesma referência só pode ser revertida uma vez. O README é ambíguo sobre um `REFUND` e um `ROLLBACK` na mesma `BET`; a decisão é **bloquear os dois**, porque permitir ambos creditaria o valor duas vezes. A regra será reforçada no banco com um índice único parcial sobre a referência das reversões processadas.

### 6.5 Mensageria
Consumidor SQS com *inbox* gravado na mesma transação do processamento (deduplicação de entregas repetidas), e *outbox* transacional para publicar eventos somente depois do commit. Erros permanentes (payload inválido, conflito de idempotência) vão para a DLQ; erros transitórios voltam à fila com backoff.

### 6.6 Workers
Um worker de outbox e um worker de reprocessamento de transações em `PENDING_REFERENCE`, ambos seguros para rodar em várias instâncias.

## 7. Limitações conhecidas e próximos passos

- Compatibilidade do MiniStack com FIFO e DLQ ainda não verificada (seção 3).
- Apenas o `Money` está implementado; carteira, regras por tipo, persistência, API, consumidor e workers estão planejados.
- Este documento será atualizado a cada etapa concluída.