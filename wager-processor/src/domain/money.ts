export type MoneyErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'NEGATIVE_RESULT'
  | 'AMOUNT_TOO_LARGE';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

const MAX_INTEGER_DIGITS = 15; // cabe em numeric(20,2) com folga
const MAX_MINOR = 10n ** BigInt(MAX_INTEGER_DIGITS + 2) - 1n;
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    /** Valor em centavos. Sempre >= 0. */
    readonly minor: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Cria a partir de uma string decimal: "25", "25.5" ou "25.50". */
  static from(amount: string, currency: string): Money {
    assertCurrency(currency);
    if (typeof amount !== 'string') {
      throw new MoneyError('INVALID_AMOUNT', 'O valor deve ser uma string decimal');
    }
    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new MoneyError(
        'INVALID_AMOUNT',
        `Valor inválido: "${amount}". Use dígitos com ponto e no máximo 2 casas decimais`,
      );
    }
    const whole = match[1]!;
    const fraction = (match[2] ?? '').padEnd(2, '0');
    return Money.fromMinor(BigInt(whole) * 100n + BigInt(fraction), currency);
  }

  static fromMinor(minor: bigint, currency: string): Money {
    assertCurrency(currency);
    if (typeof minor !== 'bigint') {
      throw new MoneyError('INVALID_AMOUNT', 'O valor em centavos deve ser bigint');
    }
    if (minor < 0n) {
      throw new MoneyError('NEGATIVE_RESULT', 'Money não pode ser negativo');
    }
    if (minor > MAX_MINOR) {
      throw new MoneyError(
        'AMOUNT_TOO_LARGE',
        `Valor acima do limite de ${MAX_INTEGER_DIGITS} dígitos inteiros`,
      );
    }
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinor(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinor(this.minor + other.minor, this.currency);
  }

  /** Lança NEGATIVE_RESULT se other for maior que this. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinor(this.minor - other.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor >= other.minor;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Sempre com 2 casas: "25.00", "25.50". */
  toString(): string {
    const whole = this.minor / 100n;
    const cents = (this.minor % 100n).toString().padStart(2, '0');
    return `${whole}.${cents}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        'CURRENCY_MISMATCH',
        `Moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}

function assertCurrency(currency: string): void {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new MoneyError(
      'INVALID_CURRENCY',
      `Moeda inválida: "${String(currency)}". Use 3 letras maiúsculas (ex.: BRL)`,
    );
  }
}