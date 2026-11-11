import { describe, expect, test } from 'bun:test';
import { LedgerEntry, LedgerInvariantError } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet, WalletError } from '../../src/domain/wallet';

const brl = (v: string) => Money.from(v, 'BRL');
const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:00:05Z');

let seq = 0;
const mv = (amount: string, extra: { currency?: string; at?: Date } = {}) => ({
  entryId: `e-${++seq}`,
  transactionId: `t-${seq}`,
  amount: Money.from(amount, extra.currency ?? 'BRL'),
  occurredAt: extra.at,
});

const openWallet = (initial = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), now: T0 });

function walletCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof WalletError ? e.code : `OTHER:${String(e)}`;
  }
  return undefined;
}

describe('Wallet.open', () => {
  test('começa com version 1 e saldo inicial', () => {
    const w = openWallet('100.00');
    expect(w.version).toBe(1);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.currency).toBe('BRL');
    expect(w.createdAt).toEqual(T0);
    expect(w.updatedAt).toEqual(T0);
  });

  test('aceita saldo inicial zero', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });

  test('exige id e playerId', () => {
    expect(walletCode(() => Wallet.open({ id: ' ', playerId: 'p', initialBalance: brl('1.00') }))).toBe('INVALID_WALLET');
    expect(walletCode(() => Wallet.open({ id: 'w', playerId: '', initialBalance: brl('1.00') }))).toBe('INVALID_WALLET');
  });
});

describe('Wallet.debit', () => {
  test('debita, sobe a version e devolve o lançamento correspondente', () => {
    const w = openWallet('100.00');
    const input = mv('30.00', { at: T1 });
    const entry = w.debit(input);

    expect(w.balance.toString()).toBe('70.00');
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(T1);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.amount.toString()).toBe('30.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('70.00');
    expect(entry.walletId).toBe('w1');
    expect(entry.transactionId).toBe(input.transactionId);
    expect(entry.id).toBe(input.entryId);
  });

  test('permite debitar exatamente o saldo (fica em zero)', () => {
    const w = openWallet('10.00');
    w.debit(mv('10.00'));
    expect(w.balance.toString()).toBe('0.00');
  });

  test('saldo insuficiente lança erro e NÃO altera nada', () => {
    const w = openWallet('10.00');
    expect(walletCode(() => w.debit(mv('10.01', { at: T1 })))).toBe('INSUFFICIENT_FUNDS');
    expect(w.balance.toString()).toBe('10.00');
    expect(w.version).toBe(1);
    expect(w.updatedAt).toEqual(T0);
  });

  test('moeda diferente é rejeitada sem alterar nada', () => {
    const w = openWallet('10.00');
    expect(walletCode(() => w.debit(mv('1.00', { currency: 'USD' })))).toBe('CURRENCY_MISMATCH');
    expect(w.version).toBe(1);
  });

  test('valor zero é rejeitado (version não sobe sem mudança de saldo)', () => {
    const w = openWallet('10.00');
    expect(walletCode(() => w.debit(mv('0.00')))).toBe('INVALID_AMOUNT');
    expect(w.version).toBe(1);
  });
});

describe('Wallet.credit', () => {
  test('credita, sobe a version e devolve o lançamento', () => {
    const w = openWallet('100.00');
    const entry = w.credit(mv('25.50', { at: T1 }));
    expect(w.balance.toString()).toBe('125.50');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('125.50');
  });

  test('crédito que estoura o limite do Money não altera nada', () => {
    const w = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('999999999999999.99') });
    expect(() => w.credit(mv('0.01'))).toThrow();
    expect(w.balance.toString()).toBe('999999999999999.99');
    expect(w.version).toBe(1);
  });

  test('valor zero e moeda diferente são rejeitados', () => {
    const w = openWallet();
    expect(walletCode(() => w.credit(mv('0.00')))).toBe('INVALID_AMOUNT');
    expect(walletCode(() => w.credit(mv('1.00', { currency: 'USD' })))).toBe('CURRENCY_MISMATCH');
    expect(w.version).toBe(1);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói exatamente o estado persistido, sem alterar version', () => {
    const w = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toString()).toBe('42.00');
    expect(w.updatedAt).toEqual(T1);
    w.debit(mv('2.00'));
    expect(w.version).toBe(8);
  });
});

describe('LedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    createdAt: T0,
  };

  test('rejeita lançamento aritmeticamente inconsistente', () => {
    expect(() =>
      LedgerEntry.of({ ...base, direction: 'CREDIT', amount: brl('10.00'), balanceBefore: brl('5.00'), balanceAfter: brl('14.00') }),
    ).toThrow(LedgerInvariantError);
    expect(() =>
      LedgerEntry.of({ ...base, direction: 'DEBIT', amount: brl('10.00'), balanceBefore: brl('15.00'), balanceAfter: brl('4.00') }),
    ).toThrow(LedgerInvariantError);
  });

  test('rejeita valor zero', () => {
    expect(() =>
      LedgerEntry.of({ ...base, direction: 'CREDIT', amount: brl('0.00'), balanceBefore: brl('5.00'), balanceAfter: brl('5.00') }),
    ).toThrow(LedgerInvariantError);
  });

  test('é imutável', () => {
    const e = LedgerEntry.of({ ...base, direction: 'CREDIT', amount: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('1.00') });
    expect(Object.isFrozen(e)).toBe(true);
  });

  test('lançamento de abertura vai de 0 ao saldo inicial', () => {
    const e = LedgerEntry.opening({ id: 'e', walletId: 'w', transactionId: 'open', initialBalance: brl('100.00'), createdAt: T0 });
    expect(e.direction).toBe('CREDIT');
    expect(e.balanceBefore.toString()).toBe('0.00');
    expect(e.balanceAfter.toString()).toBe('100.00');
  });
});

describe('consistência saldo x ledger', () => {
  test('após 2000 operações aleatórias, saldo == soma do ledger e nunca ficou negativo', () => {
    // gerador pseudoaleatório determinístico (reprodutível)
    let s = 123456789;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);

    const w = openWallet('50.00');
    const ledger: LedgerEntry[] = [
      LedgerEntry.opening({ id: 'open', walletId: 'w1', transactionId: 'open', initialBalance: brl('50.00'), createdAt: T0 }),
    ];
    let rejected = 0;
    let versionBumps = 0;

    for (let i = 0; i < 2000; i++) {
      const cents = Math.floor(rnd() * 20000) + 1; // 0.01 .. 200.00
      const amount = Money.fromMinor(BigInt(cents), 'BRL');
      const input = { entryId: `e${i}`, transactionId: `t${i}`, amount };
      const before = w.version;
      try {
        ledger.push(rnd() < 0.5 ? w.debit(input) : w.credit(input));
        versionBumps += 1;
        expect(w.version).toBe(before + 1);
      } catch (e) {
        expect(e).toBeInstanceOf(WalletError);
        expect(w.version).toBe(before);
        rejected += 1;
      }
      expect(w.balance.minor >= 0n).toBe(true);
    }

    const replayed = ledger.reduce((acc, e) => acc + e.signedMinor(), 0n);
    expect(replayed).toBe(w.balance.minor);
    expect(w.version).toBe(1 + versionBumps);
    expect(rejected).toBeGreaterThan(0); // o cenário exercitou rejeições
    // encadeamento: cada lançamento parte do saldo final do anterior
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]!.balanceBefore.equals(ledger[i - 1]!.balanceAfter)).toBe(true);
    }
  });
});