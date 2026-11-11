/**
 * Transição de estado inválida. É erro de programação, não caminho de negócio:
 * quem chama deve ter checado `isTerminal()` antes.
 */
export class InvalidTransactionStateError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Transação ${transactionId}: transição inválida ${from} -> ${to}`);
    this.name = 'InvalidTransactionStateError';
  }
}

/** Dados da transação incompatíveis com o seu kind (ex.: REFUND sem referência). */
export class InvalidTransactionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidTransactionError';
  }
}