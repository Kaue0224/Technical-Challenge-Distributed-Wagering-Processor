import { FailureCode } from './failure-code';
import type { LedgerEntry } from './ledger-entry';
import { Money } from './money';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from './transaction-errors';

/** Direção de um lançamento: 'DEBIT' | 'CREDIT', derivada do próprio LedgerEntry. */
export type LedgerDirection = LedgerEntry['direction'];

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED', // terminal
  Rejected = 'REJECTED', // terminal
  Failed = 'FAILED', // terminal
}

/**
 * Transições válidas (tabela única, fácil de documentar e de testar):
 *
 *   PENDING            -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE  -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PROCESSED / REJECTED / FAILED -> (nenhuma: terminais)
 *
 * PENDING_REFERENCE -> PENDING_REFERENCE é permitido porque o worker tenta de novo
 * a cada ciclo e a referência pode continuar ausente.
 */
const { Pending, PendingReference, Processed, Rejected, Failed } =
  WagerTransactionStatus;
const ALLOWED: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> =
  {
    [Pending]: [PendingReference, Processed, Rejected, Failed],
    [PendingReference]: [PendingReference, Processed, Rejected, Failed],
    [Processed]: [],
    [Rejected]: [],
    [Failed]: [],
  };

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState
  extends Omit<CreateWagerTransactionProps, 'createdAt'> {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. OPENING é interno e não pode ser criado por aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError(
        'OPENING_NOT_SUBMITTABLE',
        'OPENING é interno e não pode ser submetido',
      );
    }
    const ref = props.referenceExternalTransactionId?.trim();
    const needsRef = WagerTransaction.kindRequiresReference(props.kind);
    if (needsRef && !ref) {
      throw new InvalidTransactionError(
        'REFERENCE_REQUIRED',
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }
    if (!needsRef && props.referenceExternalTransactionId !== undefined) {
      throw new InvalidTransactionError(
        'REFERENCE_NOT_ALLOWED',
        `${props.kind} não aceita referenceExternalTransactionId`,
      );
    }
    return WagerTransaction.build(props, Pending, ref);
  }

  /** Crédito de abertura da wallet: já nasce PROCESSED, na mesma transação SQL da wallet. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt?: Date;
  }): WagerTransaction {
    const at = props.createdAt ?? new Date();
    const key = `opening:${props.walletId}`;
    const tx = WagerTransaction.build(
      {
        id: props.id,
        providerId: 'internal',
        externalTransactionId: key,
        idempotencyKey: key,
        payloadHash: key,
        walletId: props.walletId,
        playerId: props.playerId,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: props.money,
        createdAt: at,
      },
      Processed,
      undefined,
    );
    tx._processedAt = at;
    return tx;
  }

  /** Reconstrução a partir da persistência. Não revalida transições. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se não permitidas)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionError(
        'REFERENCE_REQUIRED',
        `${this.kind} só pode ser processada com a transação referenciada`,
      );
    }
    if (!this.requiresReference() && referenceTransactionId) {
      throw new InvalidTransactionError(
        'REFERENCE_NOT_ALLOWED',
        `${this.kind} não tem referência`,
      );
    }
    this.transitionTo(Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    if (!this.requiresReference()) {
      throw new InvalidTransactionError(
        'REFERENCE_NOT_ALLOWED',
        `${this.kind} não depende de referência`,
      );
    }
    this.transitionTo(PendingReference);
  }

  reject(code: FailureCode): void {
    this.transitionTo(Rejected);
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.transitionTo(Failed);
    this._failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return ALLOWED[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.kindRequiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET debita; WIN, REFUND e OPENING creditam; ROLLBACK é o inverso da referência.
   * LOSS não gera lançamento, então pedir sua direção é erro de programação.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return 'DEBIT';
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return 'CREDIT';
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError(
          'NO_LEDGER_ENTRY',
          'LOSS não afeta o saldo e não gera lançamento',
        );
      case WagerTransactionKind.Rollback: {
        const reversible = [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ];
        if (!reference || !reversible.includes(reference.kind)) {
          throw new InvalidTransactionError(
            'REFERENCE_KIND_INVALID',
            'ROLLBACK precisa referenciar BET, WIN ou REFUND',
          );
        }
        return reference.ledgerDirectionFor() === 'DEBIT'
          ? 'CREDIT'
          : 'DEBIT';
      }
    }
  }

  // ---- internos

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }

  private static kindRequiresReference(kind: WagerTransactionKind): boolean {
    return (
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
    );
  }

  private static build(
    p: CreateWagerTransactionProps,
    status: WagerTransactionStatus,
    ref: string | undefined,
  ): WagerTransaction {
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      ref,
      p.createdAt ?? new Date(),
      status,
    );
  }
}