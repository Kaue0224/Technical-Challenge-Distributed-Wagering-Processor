import { LedgerEntry } from './ledger-entry';
import { Money } from './money';

export type WalletErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'INVALID_WALLET';

export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementInput {
  /** Id do lançamento do ledger que será gerado. */
  entryId: string;
  /** Transação que originou a movimentação. */
  transactionId: string;
  amount: Money;
  /** Instante da movimentação (injetável para testes). Padrão: agora. */
  occurredAt?: Date;
}

/**
 * Carteira. Toda movimentação (debit/credit) atualiza o saldo e devolve o
 * LedgerEntry correspondente, de forma que saldo e ledger nunca divergem.
 *
 * Invariantes:
 *  - o saldo nunca fica negativo;
 *  - a version só sobe quando o saldo muda (todo débito/crédito válido tem valor > 0);
 *  - uma movimentação rejeitada não altera nenhum estado.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new WalletError('INVALID_WALLET', 'id e playerId são obrigatórios');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Debita o valor. Lança INSUFFICIENT_FUNDS se o saldo não cobrir. */
  debit(input: MovementInput): LedgerEntry {
    this.assertMovement(input.amount);
    if (input.amount.isGreaterThan(this._balance)) {
      throw new WalletError(
        'INSUFFICIENT_FUNDS',
        `Saldo ${this._balance.toString()} insuficiente para debitar ${input.amount.toString()}`,
      );
    }
    return this.apply('DEBIT', this._balance.subtract(input.amount), input);
  }

  /** Credita o valor. */
  credit(input: MovementInput): LedgerEntry {
    this.assertMovement(input.amount);
    return this.apply('CREDIT', this._balance.add(input.amount), input);
  }

  /** Cria o lançamento e só então altera o estado (tudo ou nada). */
  private apply(direction: 'CREDIT' | 'DEBIT', newBalance: Money, input: MovementInput): LedgerEntry {
    const now = input.occurredAt ?? new Date();
    const entry = LedgerEntry.of({
      id: input.entryId,
      walletId: this.id,
      transactionId: input.transactionId,
      direction,
      amount: input.amount,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: now,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = now;
    return entry;
  }

  private assertMovement(amount: Money): void {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new WalletError('INVALID_AMOUNT', 'O valor da movimentação deve ser maior que zero');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new WalletError(
        'CURRENCY_MISMATCH',
        `Carteira em ${this.currency} não aceita movimentação em ${money.currency}`,
      );
    }
  }
}