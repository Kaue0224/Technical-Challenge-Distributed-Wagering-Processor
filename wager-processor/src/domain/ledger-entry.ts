import { Money } from './money';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  /** Transação (aposta, prêmio, estorno...) que originou a movimentação. */
  transactionId: string;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerInvariantError';
  }
}

/**
 * Lançamento imutável do ledger. O construtor é privado e `of` valida a
 * invariante aritmética, então não existe LedgerEntry inconsistente:
 *   CREDIT: balanceBefore + amount = balanceAfter
 *   DEBIT:  balanceBefore - amount = balanceAfter
 */
export class LedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly amount: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static of(props: LedgerEntryProps): LedgerEntry {
    const { amount, balanceBefore, balanceAfter, direction } = props;
    if (!amount.isPositive()) {
      throw new LedgerInvariantError('O valor do lançamento deve ser maior que zero');
    }
    if (direction !== 'CREDIT' && direction !== 'DEBIT') {
      throw new LedgerInvariantError(`Direção inválida: ${String(direction)}`);
    }
    if (balanceBefore.currency !== amount.currency || balanceAfter.currency !== amount.currency) {
      throw new LedgerInvariantError('Moedas do lançamento divergem');
    }
    const expected =
      direction === 'CREDIT' ? balanceBefore.minor + amount.minor : balanceBefore.minor - amount.minor;
    if (expected !== balanceAfter.minor) {
      throw new LedgerInvariantError('Saldo depois não corresponde a saldo antes e valor');
    }
    return new LedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      direction,
      amount,
      balanceBefore,
      balanceAfter,
      props.createdAt,
    );
  }

  /** Lançamento de abertura da carteira: saldo 0 -> saldo inicial. */
  static opening(props: {
    id: string;
    walletId: string;
    transactionId: string;
    initialBalance: Money;
    createdAt: Date;
  }): LedgerEntry {
    return LedgerEntry.of({
      id: props.id,
      walletId: props.walletId,
      transactionId: props.transactionId,
      direction: 'CREDIT',
      amount: props.initialBalance,
      balanceBefore: Money.zero(props.initialBalance.currency),
      balanceAfter: props.initialBalance,
      createdAt: props.createdAt,
    });
  }

  /** Efeito do lançamento no saldo, em centavos (positivo ou negativo). */
  signedMinor(): bigint {
    return this.direction === 'CREDIT' ? this.amount.minor : -this.amount.minor;
  }
}