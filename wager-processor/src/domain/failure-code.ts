/**
 * Taxonomia estável e legível por máquina. Nunca renomeie um valor já publicado.
 *
 * Coluna "Provedor deve": o que o provedor pode fazer ao receber o código.
 *
 *  REJECTED (regra de negócio)
 *  INSUFFICIENT_FUNDS          BET sem saldo                          -> desistir ou pedir depósito
 *  REVERSAL_WOULD_OVERDRAW     reversão deixaria saldo negativo       -> escalar para operação
 *  WALLET_NOT_FOUND            wallet inexistente                     -> corrigir payload
 *  CURRENCY_MISMATCH           moeda diferente da wallet/referência   -> corrigir payload
 *  REFERENCE_NOT_FOUND         referência não chegou no prazo         -> reenviar a referência e depois a reversão
 *  REFERENCE_NOT_PROCESSED     referência terminou REJECTED/FAILED    -> desistir
 *  REFERENCE_KIND_INVALID      REFUND só de BET; ROLLBACK de BET/WIN/REFUND -> corrigir payload
 *  REFERENCE_MISMATCH          provider/player/wallet/rodada diferem  -> corrigir payload
 *  REFERENCE_AMOUNT_MISMATCH   valor diferente da referência          -> corrigir payload
 *  ALREADY_REVERSED            referência já revertida                -> desistir
 *
 *  FAILED (infraestrutura, terminal e auditável)
 *  INFRASTRUCTURE_ERROR        erro permanente após esgotar retries   -> reenviar com nova chave após contato com a operação
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  WalletNotFound = 'WALLET_NOT_FOUND',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindInvalid = 'REFERENCE_KIND_INVALID',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  InfrastructureError = 'INFRASTRUCTURE_ERROR',
}