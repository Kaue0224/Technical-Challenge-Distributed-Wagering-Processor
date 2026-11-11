import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../src/domain/transaction-errors';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';

const brl = (v: string) => Money.from(v, 'BRL');
const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:00:05Z');

let seq = 0;
const needsRef = (k: Kind) => k === Kind.Refund || k === Kind.Rollback;

function make(
  kind: Kind,
  extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  seq += 1;
  return WagerTransaction.create({
    id: `t-${seq}`,
    providerId: 'prov',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `key-${seq}`,
    payloadHash: 'hash-a',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl('10.00'),
    referenceExternalTransactionId: needsRef(kind) ? 'ext-ref' : undefined,
    createdAt: T0,
    ...extra,
  });
}

/** Leva uma transação a um estado usando apenas transições públicas. */
function inState(status: Status, kind: Kind = Kind.Bet): WagerTransaction {
  const tx = make(kind);
  const ref = needsRef(kind) ? 'ref-id' : undefined;
  switch (status) {
    case Status.Pending:
      break;
    case Status.PendingReference:
      tx.markPendingReference();
      break;
    case Status.Processed:
      tx.markProcessed(ref, T1);
      break;
    case Status.Rejected:
      tx.reject(FailureCode.InsufficientFunds);
      break;
    case Status.Failed:
      tx.fail(FailureCode.InfrastructureError);
      break;
  }
  return tx;
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function codeOf(fn: () => unknown): string | undefined {
  const e = errorOf(fn);
  if (e === undefined) return undefined;
  return e instanceof InvalidTransactionError ? e.code : `OTHER:${String(e)}`;
}

describe('WagerTransaction.create', () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s nasce PENDING, sem referência', (kind) => {
    const tx = make(kind);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.kind).toBe(kind);
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.createdAt).toEqual(T0);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s nasce PENDING com a referência do provedor', (kind) => {
    const tx = make(kind, { referenceExternalTransactionId: '  ext-9  ' });
    expect(tx.status).toBe(Status.Pending);
    expect(tx.referenceExternalTransactionId).toBe('ext-9');
  });

  test('guarda os dados recebidos', () => {
    const tx = make(Kind.Bet);
    expect(tx.providerId).toBe('prov');
    expect(tx.walletId).toBe('w1');
    expect(tx.playerId).toBe('p1');
    expect(tx.roundId).toBe('r1');
    expect(tx.gameId).toBe('g1');
    expect(tx.money.toString()).toBe('10.00');
  });

  test('OPENING é interno e não pode ser criado por create', () => {
    expect(codeOf(() => make(Kind.Opening))).toBe('OPENING_NOT_SUBMITTABLE');
  });

  test.each([Kind.Refund, Kind.Rollback])('%s sem referência é rejeitado', (kind) => {
    expect(codeOf(() => make(kind, { referenceExternalTransactionId: undefined }))).toBe('REFERENCE_REQUIRED');
    expect(codeOf(() => make(kind, { referenceExternalTransactionId: '' }))).toBe('REFERENCE_REQUIRED');
    expect(codeOf(() => make(kind, { referenceExternalTransactionId: '   ' }))).toBe('REFERENCE_REQUIRED');
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s com referência é rejeitado', (kind) => {
    expect(codeOf(() => make(kind, { referenceExternalTransactionId: 'ext-x' }))).toBe('REFERENCE_NOT_ALLOWED');
  });
});

describe('WagerTransaction.createOpening', () => {
  test('já nasce PROCESSED, com kind OPENING', () => {
    const tx = WagerTransaction.createOpening({
      id: 'open-1',
      walletId: 'w1',
      playerId: 'p1',
      money: brl('100.00'),
      createdAt: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(T0);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe('CREDIT');
  });

  test('a chave de idempotência é determinística por wallet', () => {
    const a = WagerTransaction.createOpening({ id: 'a', walletId: 'w1', playerId: 'p1', money: brl('1.00') });
    const b = WagerTransaction.createOpening({ id: 'b', walletId: 'w1', playerId: 'p1', money: brl('1.00') });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.externalTransactionId).toBe(b.externalTransactionId);
  });
});

describe('transições válidas', () => {
  test('PENDING -> PROCESSED registra a data e a referência interna', () => {
    const tx = make(Kind.Refund);
    tx.markProcessed('ref-1', T1);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref-1');
    expect(tx.processedAt).toEqual(T1);
    expect(tx.failureCode).toBeUndefined();
  });

  test('BET -> PROCESSED sem referência', () => {
    const tx = make(Kind.Bet);
    tx.markProcessed(undefined, T1);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  test('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const tx = make(Kind.Rollback);
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('ref-2', T1);
    expect(tx.status).toBe(Status.Processed);
  });

  test('PENDING_REFERENCE -> PENDING_REFERENCE é permitido (nova tentativa do worker)', () => {
    const tx = inState(Status.PendingReference, Kind.Refund);
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
  });

  test('PENDING -> REJECTED guarda o failureCode e não define processedAt', () => {
    const tx = make(Kind.Bet);
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toBeUndefined();
  });

  test('PENDING_REFERENCE -> REJECTED por referência inexistente', () => {
    const tx = inState(Status.PendingReference, Kind.Refund);
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test.each([Status.Pending, Status.PendingReference])('%s -> FAILED guarda o failureCode', (from) => {
    const tx = inState(from, Kind.Refund);
    tx.fail(FailureCode.InfrastructureError);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfrastructureError);
  });
});

describe('estados terminais não mudam mais', () => {
  const terminals = [Status.Processed, Status.Rejected, Status.Failed];

  test.each(terminals)('%s é terminal', (status) => {
    expect(inState(status).isTerminal()).toBe(true);
  });

  test.each([Status.Pending, Status.PendingReference])('%s não é terminal', (status) => {
    expect(inState(status, Kind.Refund).isTerminal()).toBe(false);
  });

  test.each(terminals)('qualquer transição a partir de %s lança InvalidTransactionStateError', (status) => {
    const attempts: Array<[string, (tx: WagerTransaction) => void]> = [
      ['markProcessed', (tx) => tx.markProcessed(undefined, T1)],
      ['reject', (tx) => tx.reject(FailureCode.InsufficientFunds)],
      ['fail', (tx) => tx.fail(FailureCode.InfrastructureError)],
    ];
    for (const [, attempt] of attempts) {
      const tx = inState(status);
      expect(errorOf(() => attempt(tx))).toBeInstanceOf(InvalidTransactionStateError);
      expect(tx.status).toBe(status);
    }
  });

  test.each(terminals)('markPendingReference a partir de %s lança InvalidTransactionStateError', (status) => {
    const tx = inState(status, Kind.Refund);
    expect(errorOf(() => tx.markPendingReference())).toBeInstanceOf(InvalidTransactionStateError);
    expect(tx.status).toBe(status);
  });

  test('a falha de transição não altera failureCode nem processedAt', () => {
    const tx = inState(Status.Rejected);
    expect(() => tx.fail(FailureCode.InfrastructureError)).toThrow(InvalidTransactionStateError);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    const done = inState(Status.Processed);
    expect(() => done.markProcessed(undefined, new Date('2030-01-01T00:00:00Z'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(done.processedAt).toEqual(T1);
  });

  test('o erro identifica a transação e as transições', () => {
    const tx = inState(Status.Processed);
    const e = errorOf(() => tx.reject(FailureCode.InsufficientFunds)) as InvalidTransactionStateError;
    expect(e.transactionId).toBe(tx.id);
    expect(e.from).toBe(Status.Processed);
    expect(e.to).toBe(Status.Rejected);
  });
});

describe('regras de referência nas transições', () => {
  test.each([Kind.Refund, Kind.Rollback])('%s não pode ser processada sem a transação referenciada', (kind) => {
    const tx = make(kind);
    expect(codeOf(() => tx.markProcessed(undefined, T1))).toBe('REFERENCE_REQUIRED');
    expect(tx.status).toBe(Status.Pending);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s não pode ser processada com referência', (kind) => {
    const tx = make(kind);
    expect(codeOf(() => tx.markProcessed('ref-1', T1))).toBe('REFERENCE_NOT_ALLOWED');
    expect(tx.status).toBe(Status.Pending);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s não pode ficar em PENDING_REFERENCE', (kind) => {
    const tx = make(kind);
    expect(codeOf(() => tx.markPendingReference())).toBe('REFERENCE_NOT_ALLOWED');
    expect(tx.status).toBe(Status.Pending);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance é falso só para LOSS', () => {
    expect(make(Kind.Loss).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
      expect(make(kind).affectsBalance()).toBe(true);
    }
  });

  test('requiresReference é verdadeiro só para REFUND e ROLLBACK', () => {
    expect(make(Kind.Refund).requiresReference()).toBe(true);
    expect(make(Kind.Rollback).requiresReference()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) {
      expect(make(kind).requiresReference()).toBe(false);
    }
  });

  test('matchesPayload compara o hash do payload', () => {
    const tx = make(Kind.Bet, { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
    expect(tx.matchesPayload('')).toBe(false);
  });
});

describe('ledgerDirectionFor', () => {
  const direction = (kind: Kind) => make(kind).ledgerDirectionFor();

  test('BET debita; WIN e REFUND creditam', () => {
    expect(direction(Kind.Bet)).toBe('DEBIT');
    expect(direction(Kind.Win)).toBe('CREDIT');
    expect(direction(Kind.Refund)).toBe('CREDIT');
  });

  test('LOSS não gera lançamento, então pedir a direção é erro', () => {
    expect(codeOf(() => direction(Kind.Loss))).toBe('NO_LEDGER_ENTRY');
  });

  test('ROLLBACK é o inverso da referência', () => {
    const rollback = make(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(make(Kind.Bet))).toBe('CREDIT'); // desfaz um débito
    expect(rollback.ledgerDirectionFor(make(Kind.Win))).toBe('DEBIT'); // desfaz um crédito
    expect(rollback.ledgerDirectionFor(make(Kind.Refund))).toBe('DEBIT'); // desfaz um crédito
  });

  test('ROLLBACK sem referência é erro', () => {
    expect(codeOf(() => make(Kind.Rollback).ledgerDirectionFor())).toBe('REFERENCE_KIND_INVALID');
  });

  test.each([Kind.Loss, Kind.Rollback])('ROLLBACK não pode referenciar %s', (refKind) => {
    const reference = refKind === Kind.Rollback ? make(Kind.Rollback) : make(Kind.Loss);
    expect(codeOf(() => make(Kind.Rollback).ledgerDirectionFor(reference))).toBe('REFERENCE_KIND_INVALID');
  });

  test('ROLLBACK não pode referenciar OPENING', () => {
    const opening = WagerTransaction.createOpening({ id: 'o', walletId: 'w1', playerId: 'p1', money: brl('1.00') });
    expect(codeOf(() => make(Kind.Rollback).ledgerDirectionFor(opening))).toBe('REFERENCE_KIND_INVALID');
  });

  test('a direção não muda com o estado da transação', () => {
    const tx = inState(Status.Processed, Kind.Bet);
    expect(tx.ledgerDirectionFor()).toBe('DEBIT');
  });
});

describe('rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar transições', () => {
    const tx = WagerTransaction.rehydrate({
      id: 't-9',
      providerId: 'prov',
      externalTransactionId: 'ext-9',
      idempotencyKey: 'key-9',
      payloadHash: 'hash-9',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r1',
      gameId: 'g1',
      kind: Kind.Refund,
      money: brl('5.00'),
      referenceExternalTransactionId: 'ext-ref',
      createdAt: T0,
      status: Status.Processed,
      referenceTransactionId: 'ref-9',
      processedAt: T1,
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBe('ref-9');
    expect(tx.processedAt).toEqual(T1);
    expect(tx.money.toString()).toBe('5.00');
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
  });

  test('preserva o failureCode de uma transação rejeitada', () => {
    const tx = WagerTransaction.rehydrate({
      id: 't-10',
      providerId: 'prov',
      externalTransactionId: 'ext-10',
      idempotencyKey: 'key-10',
      payloadHash: 'hash-10',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r1',
      gameId: 'g1',
      kind: Kind.Bet,
      money: brl('5.00'),
      createdAt: T0,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.referenceExternalTransactionId).toBeUndefined();
  });
});