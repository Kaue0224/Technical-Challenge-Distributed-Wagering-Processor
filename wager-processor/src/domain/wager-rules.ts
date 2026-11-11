import { FailureCode } from './failure-code';
import type { LedgerEntry } from './ledger-entry';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from './transaction-errors';
import type { Wallet } from './wallet';
import { WalletError } from './wallet';
import type { WagerTransaction } from './wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface WagerRulesInput {
  /** Transação a decidir. Pode estar em PENDING ou PENDING_REFERENCE. */
  transaction: WagerTransaction;
  /** Wallet já travada. `undefined` quando não existe. */
  wallet: Wallet | undefined;
  /** Transação referenciada, resolvida por (providerId, referenceExternalTransactionId). */
  reference?: WagerTransaction | undefined;
  /**
   * Existe outra reversão PROCESSED apontando para a mesma referência
   * (REFUND ou ROLLBACK; ver ARCHITECTURE.md, seção 6.4). Calculado pelo caso de uso.
   */
  alreadyReversed?: boolean;
  /** Id do lançamento do ledger, caso o movimento gere um. */
  entryId: string;
  /** Instante da decisão (injetável para testes). */
  now: Date;
}

export type WagerDecision =
  /** Transação PROCESSED. `entry` é indefinido apenas para LOSS. */
  | { readonly type: 'APPLY'; readonly entry: LedgerEntry | undefined }
  /** Transação REJECTED. Saldo e ledger intactos. */
  | { readonly type: 'REJECT'; readonly failureCode: FailureCode }
  /** Transação PENDING_REFERENCE. Saldo e ledger intactos. */
  | { readonly type: 'WAIT_REFERENCE' };

const { Bet, Win, Refund } = WagerTransactionKind;
const { Pending, PendingReference, Processed } = WagerTransactionStatus;

export function applyWagerRules(input: WagerRulesInput): WagerDecision {
  const { transaction: tx, wallet, now } = input;

  // Erro de programação, não caminho de negócio: quem chama checa isTerminal() antes.
  // A guarda vem antes de qualquer mutação para não mexer na wallet à toa.
  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(tx.id, tx.status, 'DECIDED');
  }

  if (!wallet) {
    return reject(tx, FailureCode.WalletNotFound);
  }
  if (wallet.id !== tx.walletId) {
    throw new InvalidTransactionError(
      'WALLET_MISMATCH',
      `A wallet ${wallet.id} não é a wallet ${tx.walletId} da transação ${tx.id}`,
    );
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(tx, FailureCode.CurrencyMismatch);
  }

  if (!tx.requiresReference()) {
    return applyMovement(tx, wallet, undefined, input.entryId, now);
  }

  const reference = input.reference;
  if (!reference) {
    return waitForReference(tx);
  }

  const allowedKinds =
    tx.kind === Refund ? [Bet] : [Bet, Win, Refund];
  if (!allowedKinds.includes(reference.kind)) {
    return reject(tx, FailureCode.ReferenceKindInvalid);
  }
  if (reference.status === Pending || reference.status === PendingReference) {
    return waitForReference(tx);
  }
  if (reference.status !== Processed) {
    return reject(tx, FailureCode.ReferenceNotProcessed);
  }
  if (
    reference.providerId !== tx.providerId ||
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.roundId !== tx.roundId
  ) {
    return reject(tx, FailureCode.ReferenceMismatch);
  }
  if (reference.money.currency !== tx.money.currency) {
    return reject(tx, FailureCode.CurrencyMismatch);
  }
  if (!reference.money.equals(tx.money)) {
    return reject(tx, FailureCode.ReferenceAmountMismatch);
  }
  if (input.alreadyReversed === true) {
    return reject(tx, FailureCode.AlreadyReversed);
  }

  return applyMovement(tx, wallet, reference, input.entryId, now);
}

function applyMovement(
  tx: WagerTransaction,
  wallet: Wallet,
  reference: WagerTransaction | undefined,
  entryId: string,
  now: Date,
): WagerDecision {
  if (!tx.affectsBalance()) {
    tx.markProcessed(undefined, now);
    return { type: 'APPLY', entry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = {
    entryId,
    transactionId: tx.id,
    amount: tx.money,
    occurredAt: now,
  };

  let entry: LedgerEntry;
  try {
    entry = direction === 'DEBIT' ? wallet.debit(movement) : wallet.credit(movement);
  } catch (error) {
    // A wallet não altera nada quando recusa a movimentação.
    if (error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS') {
      return reject(
        tx,
        tx.kind === WagerTransactionKind.Rollback
          ? FailureCode.ReversalWouldOverdraw
          : FailureCode.InsufficientFunds,
      );
    }
    throw error;
  }

  tx.markProcessed(reference?.id, now);
  return { type: 'APPLY', entry };
}

function reject(tx: WagerTransaction, code: FailureCode): WagerDecision {
  tx.reject(code);
  return { type: 'REJECT', failureCode: code };
}

function waitForReference(tx: WagerTransaction): WagerDecision {
  tx.markPendingReference();
  return { type: 'WAIT_REFERENCE' };
}