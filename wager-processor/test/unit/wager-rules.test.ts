import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import type { LedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../src/domain/transaction-errors';
import { Wallet } from '../../src/domain/wallet';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';
import {
  applyWagerRules,
  type WagerDecision,
  type WagerRulesInput,
} from '../../src/domain/wager-rules';

// ---------------------------------------------------------------- helpers

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:00:10.000Z');

const brl = (amount: string): Money => Money.from(amount, 'BRL');

function walletWith(balance: string, id = 'w1'): Wallet {
  return Wallet.open({
    id,
    playerId: 'p1',
    initialBalance: brl(balance),
    now: T0,
  });
}

function newTx(
  id: string,
  kind: Kind,
  amount: string,
  extra: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id,
    providerId: 'prov-a',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `prov-a:ext-${id}`,
    payloadHash: `hash-${id}`,
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl(amount),
    ...extra,
  });
}

/** Reversão (REFUND ou ROLLBACK) apontando para a referência de id externo `ext-<refId>`. */
function reversal(
  id: string,
  kind: Kind.Refund | Kind.Rollback,
  amount: string,
  refId: string,
  extra: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return newTx(id, kind, amount, {
    referenceExternalTransactionId: `ext-${refId}`,
    ...extra,
  });
}

/** Transação já PROCESSED, para servir de referência sem passar pelas regras. */
function processedTx(
  id: string,
  kind: Kind,
  amount: string,
  extra: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const tx = newTx(id, kind, amount, extra);
  tx.markProcessed(tx.requiresReference() ? 'origin' : undefined, T0);
  return tx;
}

let entrySeq = 0;
function run(
  tx: WagerTransaction,
  over: Partial<WagerRulesInput> = {},
): WagerDecision {
  entrySeq += 1;
  return applyWagerRules({
    transaction: tx,
    wallet: walletWith('100.00'),
    entryId: `entry-${entrySeq}`,
    now: T1,
    ...over,
  });
}

function entryOf(decision: WagerDecision): LedgerEntry {
  if (decision.type !== 'APPLY' || !decision.entry) {
    throw new Error(`esperava APPLY com lançamento, veio ${JSON.stringify(decision)}`);
  }
  return decision.entry;
}

const rejected = (code: FailureCode): WagerDecision => ({
  type: 'REJECT',
  failureCode: code,
});
const waiting: WagerDecision = { type: 'WAIT_REFERENCE' };

/** Wallet e transação não podem ter mudado depois de um REJECT ou WAIT_REFERENCE. */
function expectWalletUntouched(wallet: Wallet, balance: string): void {
  expect(wallet.balance.toString()).toBe(balance);
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(T0);
}

// ------------------------------------------------------------------ casos

describe('applyWagerRules: BET', () => {
  test('debita o valor e deixa a aposta PROCESSED', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '25.00');

    const entry = entryOf(run(bet, { wallet }));

    expect(entry.direction).toBe('DEBIT');
    expect(entry.amount.toString()).toBe('25.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.processedAt).toEqual(T1);
    expect(bet.referenceTransactionId).toBeUndefined();
  });

  test('o lançamento carrega o id, a transação de origem e o instante da decisão', () => {
    const bet = newTx('bet-1', Kind.Bet, '10.00');

    const entry = entryOf(run(bet, { entryId: 'entry-xyz' }));

    expect(entry.id).toBe('entry-xyz');
    expect(entry.transactionId).toBe('bet-1');
    expect(entry.walletId).toBe('w1');
    expect(entry.createdAt).toEqual(T1);
  });

  test('aposta igual ao saldo é permitida e zera a wallet', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '100.00');

    entryOf(run(bet, { wallet }));

    expect(wallet.balance.toString()).toBe('0.00');
    expect(bet.status).toBe(Status.Processed);
  });

  test('aposta acima do saldo é rejeitada com INSUFFICIENT_FUNDS e não altera nada', () => {
    const wallet = walletWith('20.00');
    const bet = newTx('bet-1', Kind.Bet, '80.00');

    const out = run(bet, { wallet });

    expect(out).toEqual(rejected(FailureCode.InsufficientFunds));
    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expectWalletUntouched(wallet, '20.00');
  });
});

describe('applyWagerRules: WIN e LOSS', () => {
  test('WIN credita o valor', () => {
    const wallet = walletWith('100.00');
    const win = newTx('win-1', Kind.Win, '60.00');

    const entry = entryOf(run(win, { wallet }));

    expect(entry.direction).toBe('CREDIT');
    expect(wallet.balance.toString()).toBe('160.00');
    expect(wallet.version).toBe(2);
    expect(win.status).toBe(Status.Processed);
  });

  test('LOSS é processada sem mover saldo e sem gerar lançamento', () => {
    const wallet = walletWith('100.00');
    const loss = newTx('loss-1', Kind.Loss, '25.00');

    const out = run(loss, { wallet });

    expect(out).toEqual({ type: 'APPLY', entry: undefined });
    expect(loss.status).toBe(Status.Processed);
    expect(loss.processedAt).toEqual(T1);
    expectWalletUntouched(wallet, '100.00');
  });
});

describe('applyWagerRules: REFUND', () => {
  test('credita de volta o valor de uma BET processada e registra a referência', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    entryOf(run(bet, { wallet })); // saldo 70.00

    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');
    const entry = entryOf(run(refund, { wallet, reference: bet }));

    expect(entry.direction).toBe('CREDIT');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe('bet-1');
  });

  test('REFUND de uma WIN é rejeitado com REFERENCE_KIND_INVALID', () => {
    const wallet = walletWith('100.00');
    const win = processedTx('win-1', Kind.Win, '30.00');
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'win-1');

    expect(run(refund, { wallet, reference: win })).toEqual(
      rejected(FailureCode.ReferenceKindInvalid),
    );
    expectWalletUntouched(wallet, '100.00');
  });
});

describe('applyWagerRules: ROLLBACK', () => {
  test('de uma BET credita o valor', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    entryOf(run(bet, { wallet })); // 70.00

    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');
    const entry = entryOf(run(rollback, { wallet, reference: bet }));

    expect(entry.direction).toBe('CREDIT');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(rollback.referenceTransactionId).toBe('bet-1');
  });

  test('de uma WIN debita o valor', () => {
    const wallet = walletWith('100.00');
    const win = newTx('win-1', Kind.Win, '50.00');
    entryOf(run(win, { wallet })); // 150.00

    const rollback = reversal('rb-1', Kind.Rollback, '50.00', 'win-1');
    const entry = entryOf(run(rollback, { wallet, reference: win }));

    expect(entry.direction).toBe('DEBIT');
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('de um REFUND debita o valor (a referência é o próprio REFUND)', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    entryOf(run(bet, { wallet })); // 70.00
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');
    entryOf(run(refund, { wallet, reference: bet })); // 100.00

    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'refund-1');
    const entry = entryOf(run(rollback, { wallet, reference: refund }));

    expect(entry.direction).toBe('DEBIT');
    expect(wallet.balance.toString()).toBe('70.00');
  });

  test('que deixaria o saldo negativo é rejeitado com REVERSAL_WOULD_OVERDRAW', () => {
    const wallet = walletWith('100.00');
    const win = newTx('win-1', Kind.Win, '50.00');
    entryOf(run(win, { wallet })); // 150.00
    const bet = newTx('bet-2', Kind.Bet, '140.00');
    entryOf(run(bet, { wallet })); // 10.00
    const versionBefore = wallet.version;

    const rollback = reversal('rb-1', Kind.Rollback, '50.00', 'win-1');
    const out = run(rollback, { wallet, reference: win });

    expect(out).toEqual(rejected(FailureCode.ReversalWouldOverdraw));
    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(versionBefore);
  });

  test('REVERSAL_WOULD_OVERDRAW é distinto de INSUFFICIENT_FUNDS', () => {
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
  });
});

describe('applyWagerRules: referência ausente ou ainda não terminal', () => {
  test('reversão sem a referência carregada vai para PENDING_REFERENCE', () => {
    const wallet = walletWith('100.00');
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');

    const out = run(rollback, { wallet });

    expect(out).toEqual(waiting);
    expect(rollback.status).toBe(Status.PendingReference);
    expectWalletUntouched(wallet, '100.00');
  });

  test('REFUND sem a referência também espera', () => {
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');

    expect(run(refund)).toEqual(waiting);
    expect(refund.status).toBe(Status.PendingReference);
  });

  test('referência ainda PENDING faz a reversão esperar', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00'); // PENDING
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');

    expect(run(refund, { wallet, reference: bet })).toEqual(waiting);
    expect(refund.status).toBe(Status.PendingReference);
    expectWalletUntouched(wallet, '100.00');
  });

  test('referência em PENDING_REFERENCE faz a reversão esperar', () => {
    const wallet = walletWith('100.00');
    const pendingRefund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');
    pendingRefund.markPendingReference();
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'refund-1');

    expect(run(rollback, { wallet, reference: pendingRefund })).toEqual(waiting);
    expect(rollback.status).toBe(Status.PendingReference);
  });

  test('esperar de novo continua em PENDING_REFERENCE (transição permitida)', () => {
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');

    run(rollback);
    expect(run(rollback)).toEqual(waiting);
    expect(rollback.status).toBe(Status.PendingReference);
  });

  test('quando a referência chega, a transação em PENDING_REFERENCE é aplicada', () => {
    const wallet = walletWith('100.00');
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');
    expect(run(rollback, { wallet })).toEqual(waiting);

    const bet = newTx('bet-1', Kind.Bet, '30.00');
    entryOf(run(bet, { wallet })); // 70.00
    const entry = entryOf(run(rollback, { wallet, reference: bet }));

    expect(entry.direction).toBe('CREDIT');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(rollback.status).toBe(Status.Processed);
    expect(rollback.referenceTransactionId).toBe('bet-1');
  });
});

describe('applyWagerRules: rejeições de referência', () => {
  const invalidKindCases: Array<{
    name: string;
    kind: Kind.Refund | Kind.Rollback;
    reference: () => WagerTransaction;
  }> = [
    {
      name: 'REFUND de uma WIN',
      kind: Kind.Refund,
      reference: () => processedTx('ref', Kind.Win, '30.00'),
    },
    {
      name: 'REFUND de uma LOSS',
      kind: Kind.Refund,
      reference: () => processedTx('ref', Kind.Loss, '30.00'),
    },
    {
      name: 'REFUND de um REFUND',
      kind: Kind.Refund,
      reference: () =>
        processedTx('ref', Kind.Refund, '30.00', {
          referenceExternalTransactionId: 'ext-origin',
        }),
    },
    {
      name: 'ROLLBACK de uma LOSS',
      kind: Kind.Rollback,
      reference: () => processedTx('ref', Kind.Loss, '30.00'),
    },
    {
      name: 'ROLLBACK de um ROLLBACK',
      kind: Kind.Rollback,
      reference: () =>
        processedTx('ref', Kind.Rollback, '30.00', {
          referenceExternalTransactionId: 'ext-origin',
        }),
    },
    {
      name: 'ROLLBACK de um OPENING',
      kind: Kind.Rollback,
      reference: () =>
        WagerTransaction.createOpening({
          id: 'ref',
          walletId: 'w1',
          playerId: 'p1',
          money: brl('30.00'),
        }),
    },
  ];

  for (const c of invalidKindCases) {
    test(`${c.name} é REFERENCE_KIND_INVALID`, () => {
      const wallet = walletWith('100.00');
      const tx = reversal('rev-1', c.kind, '30.00', 'ref');

      expect(run(tx, { wallet, reference: c.reference() })).toEqual(
        rejected(FailureCode.ReferenceKindInvalid),
      );
      expect(tx.status).toBe(Status.Rejected);
      expectWalletUntouched(wallet, '100.00');
    });
  }

  test('referência REJECTED é REFERENCE_NOT_PROCESSED', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    bet.reject(FailureCode.InsufficientFunds);
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');

    expect(run(refund, { wallet, reference: bet })).toEqual(
      rejected(FailureCode.ReferenceNotProcessed),
    );
    expectWalletUntouched(wallet, '100.00');
  });

  test('referência FAILED é REFERENCE_NOT_PROCESSED', () => {
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    bet.fail(FailureCode.InfrastructureError);
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');

    expect(run(rollback, { reference: bet })).toEqual(
      rejected(FailureCode.ReferenceNotProcessed),
    );
  });

  const mismatchCases: Array<{
    name: string;
    extra: Partial<CreateWagerTransactionProps>;
  }> = [
    { name: 'provider', extra: { providerId: 'prov-b' } },
    { name: 'player', extra: { playerId: 'p2' } },
    { name: 'wallet', extra: { walletId: 'w2' } },
    { name: 'rodada', extra: { roundId: 'r2' } },
  ];

  for (const c of mismatchCases) {
    test(`${c.name} diferente da referência é REFERENCE_MISMATCH`, () => {
      const wallet = walletWith('100.00');
      const bet = processedTx('bet-1', Kind.Bet, '30.00', c.extra);
      const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');

      expect(run(refund, { wallet, reference: bet })).toEqual(
        rejected(FailureCode.ReferenceMismatch),
      );
      expectWalletUntouched(wallet, '100.00');
    });
  }

  test('moeda diferente da referência é CURRENCY_MISMATCH', () => {
    const wallet = walletWith('100.00');
    const bet = processedTx('bet-1', Kind.Bet, '30.00', {
      money: Money.from('30.00', 'USD'),
    });
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');

    expect(run(refund, { wallet, reference: bet })).toEqual(
      rejected(FailureCode.CurrencyMismatch),
    );
    expectWalletUntouched(wallet, '100.00');
  });

  test('valor diferente da referência é REFERENCE_AMOUNT_MISMATCH (também para menos)', () => {
    const wallet = walletWith('100.00');
    const bet = processedTx('bet-1', Kind.Bet, '30.00');

    const higher = reversal('refund-1', Kind.Refund, '30.01', 'bet-1');
    const lower = reversal('refund-2', Kind.Refund, '29.99', 'bet-1');

    expect(run(higher, { wallet, reference: bet })).toEqual(
      rejected(FailureCode.ReferenceAmountMismatch),
    );
    expect(run(lower, { wallet, reference: bet })).toEqual(
      rejected(FailureCode.ReferenceAmountMismatch),
    );
    expectWalletUntouched(wallet, '100.00');
  });

  test('referência já revertida é ALREADY_REVERSED, para REFUND e para ROLLBACK', () => {
    const wallet = walletWith('100.00');
    const bet = processedTx('bet-1', Kind.Bet, '30.00');

    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');

    expect(run(refund, { wallet, reference: bet, alreadyReversed: true })).toEqual(
      rejected(FailureCode.AlreadyReversed),
    );
    expect(run(rollback, { wallet, reference: bet, alreadyReversed: true })).toEqual(
      rejected(FailureCode.AlreadyReversed),
    );
    expectWalletUntouched(wallet, '100.00');
  });

  test('o mesmo REFUND/ROLLBACK não passa duas vezes quando o chamador informa a reversão anterior', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    entryOf(run(bet, { wallet })); // 70.00

    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');
    entryOf(run(refund, { wallet, reference: bet })); // 100.00

    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');
    const out = run(rollback, { wallet, reference: bet, alreadyReversed: true });

    expect(out).toEqual(rejected(FailureCode.AlreadyReversed));
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('applyWagerRules: wallet e moeda', () => {
  test('wallet inexistente é WALLET_NOT_FOUND', () => {
    const bet = newTx('bet-1', Kind.Bet, '30.00');

    expect(run(bet, { wallet: undefined })).toEqual(
      rejected(FailureCode.WalletNotFound),
    );
    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.WalletNotFound);
  });

  test('moeda diferente da wallet é CURRENCY_MISMATCH', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00', {
      money: Money.from('30.00', 'USD'),
    });

    expect(run(bet, { wallet })).toEqual(rejected(FailureCode.CurrencyMismatch));
    expectWalletUntouched(wallet, '100.00');
  });

  test('LOSS em moeda diferente da wallet também é rejeitada', () => {
    const wallet = walletWith('100.00');
    const loss = newTx('loss-1', Kind.Loss, '30.00', {
      money: Money.from('30.00', 'USD'),
    });

    expect(run(loss, { wallet })).toEqual(rejected(FailureCode.CurrencyMismatch));
  });

  test('uma wallet diferente da da transação é erro de programação', () => {
    const wallet = walletWith('100.00', 'w-outra');
    const bet = newTx('bet-1', Kind.Bet, '30.00');

    expect(() => run(bet, { wallet })).toThrow(InvalidTransactionError);
    expect(bet.status).toBe(Status.Pending);
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('applyWagerRules: precedência das verificações', () => {
  test('wallet inexistente vence referência ausente', () => {
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1');

    expect(run(rollback, { wallet: undefined })).toEqual(
      rejected(FailureCode.WalletNotFound),
    );
  });

  test('moeda da wallet vence referência ausente', () => {
    const rollback = reversal('rb-1', Kind.Rollback, '30.00', 'bet-1', {
      money: Money.from('30.00', 'USD'),
    });

    expect(run(rollback)).toEqual(rejected(FailureCode.CurrencyMismatch));
  });

  test('tipo inválido da referência vence referência não processada', () => {
    const win = newTx('win-1', Kind.Win, '30.00');
    win.reject(FailureCode.WalletNotFound);
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'win-1');

    expect(run(refund, { reference: win })).toEqual(
      rejected(FailureCode.ReferenceKindInvalid),
    );
  });

  test('referência não terminal vence divergência de dados', () => {
    const bet = newTx('bet-1', Kind.Bet, '30.00', { providerId: 'prov-b' });
    const refund = reversal('refund-1', Kind.Refund, '99.00', 'bet-1');

    expect(run(refund, { reference: bet })).toEqual(waiting);
  });

  test('referência não processada vence divergência de dados', () => {
    const bet = newTx('bet-1', Kind.Bet, '30.00', { providerId: 'prov-b' });
    bet.reject(FailureCode.InsufficientFunds);
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');

    expect(run(refund, { reference: bet })).toEqual(
      rejected(FailureCode.ReferenceNotProcessed),
    );
  });

  test('divergência de dados vence divergência de valor', () => {
    const bet = processedTx('bet-1', Kind.Bet, '30.00', { roundId: 'r2' });
    const refund = reversal('refund-1', Kind.Refund, '99.00', 'bet-1');

    expect(run(refund, { reference: bet })).toEqual(
      rejected(FailureCode.ReferenceMismatch),
    );
  });

  test('moeda da referência vence divergência de valor', () => {
    const bet = processedTx('bet-1', Kind.Bet, '10.00', {
      money: Money.from('10.00', 'USD'),
    });
    const refund = reversal('refund-1', Kind.Refund, '30.00', 'bet-1');

    expect(run(refund, { reference: bet })).toEqual(
      rejected(FailureCode.CurrencyMismatch),
    );
  });

  test('divergência de valor vence reversão duplicada', () => {
    const bet = processedTx('bet-1', Kind.Bet, '30.00');
    const refund = reversal('refund-1', Kind.Refund, '99.00', 'bet-1');

    expect(run(refund, { reference: bet, alreadyReversed: true })).toEqual(
      rejected(FailureCode.ReferenceAmountMismatch),
    );
  });
});

describe('applyWagerRules: cenários do README', () => {
  test('duas apostas de 80 sobre 100: uma processada, outra rejeitada, saldo 20 e um único débito', () => {
    const wallet = walletWith('100.00');
    const first = newTx('bet-1', Kind.Bet, '80.00');
    const second = newTx('bet-2', Kind.Bet, '80.00');

    const outFirst = run(first, { wallet });
    const outSecond = run(second, { wallet });

    expect(outFirst.type).toBe('APPLY');
    expect(outSecond).toEqual(rejected(FailureCode.InsufficientFunds));
    expect(first.status).toBe(Status.Processed);
    expect(second.status).toBe(Status.Rejected);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect([outFirst, outSecond].filter((o) => o.type === 'APPLY' && o.entry)).toHaveLength(1);
  });
});

describe('applyWagerRules: estados terminais e efeitos', () => {
  test('decidir uma transação já terminal é erro de programação e não mexe na wallet', () => {
    const wallet = walletWith('100.00');
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    entryOf(run(bet, { wallet })); // 70.00, bet PROCESSED
    const version = wallet.version;

    expect(() => run(bet, { wallet })).toThrow(InvalidTransactionStateError);
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(version);
  });

  test('transação REJECTED também não pode ser decidida de novo', () => {
    const bet = newTx('bet-1', Kind.Bet, '30.00');
    bet.reject(FailureCode.InsufficientFunds);

    expect(() => run(bet)).toThrow(InvalidTransactionStateError);
  });

  test('rejeições e espera nunca alteram saldo, versão nem data da wallet', () => {
    const cases: Array<() => void> = [];
    const wallet = walletWith('100.00');

    cases.push(() =>
      run(newTx('a', Kind.Bet, '500.00'), { wallet }),
    );
    cases.push(() =>
      run(reversal('b', Kind.Rollback, '10.00', 'x'), { wallet }),
    );
    cases.push(() =>
      run(
        reversal('c', Kind.Refund, '10.00', 'x'),
        { wallet, reference: processedTx('x', Kind.Win, '10.00') },
      ),
    );
    cases.push(() =>
      run(newTx('d', Kind.Loss, '10.00'), { wallet }),
    );

    for (const c of cases) c();

    expectWalletUntouched(wallet, '100.00');
  });
});

describe('applyWagerRules: consistência saldo x ledger', () => {
  test('após uma sequência mista, saldo = saldo inicial + soma assinada do ledger', () => {
    const wallet = walletWith('100.00');
    const entries: LedgerEntry[] = [];
    const record = (d: WagerDecision): void => {
      if (d.type === 'APPLY' && d.entry) entries.push(d.entry);
    };

    const bet1 = newTx('bet-1', Kind.Bet, '40.00');
    record(run(bet1, { wallet })); // 60
    const win1 = newTx('win-1', Kind.Win, '70.00');
    record(run(win1, { wallet })); // 130
    record(run(newTx('loss-1', Kind.Loss, '20.00'), { wallet })); // sem efeito
    record(run(newTx('bet-2', Kind.Bet, '500.00'), { wallet })); // rejeitada
    const refund1 = reversal('refund-1', Kind.Refund, '40.00', 'bet-1');
    record(run(refund1, { wallet, reference: bet1 })); // 170
    const rb1 = reversal('rb-1', Kind.Rollback, '70.00', 'win-1');
    record(run(rb1, { wallet, reference: win1 })); // 100
    const rb2 = reversal('rb-2', Kind.Rollback, '40.00', 'refund-1');
    record(run(rb2, { wallet, reference: refund1 })); // 60

    const initial = brl('100.00').minor;
    const sum = entries.reduce((acc, e) => acc + e.signedMinor(), 0n);

    expect(entries).toHaveLength(5);
    expect(wallet.balance.minor).toBe(initial + sum);
    expect(wallet.balance.toString()).toBe('60.00');
    expect(wallet.version).toBe(1 + entries.length);
  });
});