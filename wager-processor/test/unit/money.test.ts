import { describe, expect, test } from 'bun:test';
import { Money, MoneyError } from '../../src/domain/money';

const brl = (v: string) => Money.from(v, 'BRL');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof MoneyError ? e.code : `OTHER:${String(e)}`;
  }
  return undefined;
}

describe('Money.from', () => {
  test('normaliza para 2 casas decimais', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('25.50').toString()).toBe('25.50');
    expect(brl('0').toString()).toBe('0.00');
    expect(brl('0.05').toString()).toBe('0.05');
  });

  test('aceita zeros à esquerda e normaliza', () => {
    expect(brl('007.10').toString()).toBe('7.10');
  });

  test.each(['1.999', '-5.00', 'abc', '', '1e3', '1,50', ' 1.00', '1.00 ', '.50', '1.', '+1.00', '0x10', 'NaN', 'Infinity'])(
    'rejeita entrada inválida: %p',
    (input) => {
      expect(codeOf(() => brl(input))).toBe('INVALID_AMOUNT');
    },
  );

  test('rejeita tipos que não são string', () => {
    expect(codeOf(() => Money.from(25 as unknown as string, 'BRL'))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => Money.from(null as unknown as string, 'BRL'))).toBe('INVALID_AMOUNT');
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita moeda inválida: %p', (cur) => {
    expect(codeOf(() => Money.from('1.00', cur))).toBe('INVALID_CURRENCY');
  });

  test('limita a parte inteira a 15 dígitos', () => {
    expect(brl('999999999999999.99').toString()).toBe('999999999999999.99');
    expect(codeOf(() => brl('1000000000000000.00'))).toBe('AMOUNT_TOO_LARGE');
  });
});

describe('aritmética exata', () => {
  test('0.10 + 0.20 = 0.30 (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('valores enormes continuam exatos', () => {
    const a = brl('999999999999999.98');
    expect(a.add(brl('0.01')).toString()).toBe('999999999999999.99');
  });

  test('soma que estoura o limite lança erro', () => {
    expect(codeOf(() => brl('999999999999999.99').add(brl('0.01')))).toBe('AMOUNT_TOO_LARGE');
  });

  test('subtração exata', () => {
    expect(brl('100.00').subtract(brl('0.01')).toString()).toBe('99.99');
    expect(brl('10.00').subtract(brl('10.00')).isZero()).toBe(true);
  });

  test('subtrair mais do que existe lança NEGATIVE_RESULT', () => {
    expect(codeOf(() => brl('10.00').subtract(brl('10.01')))).toBe('NEGATIVE_RESULT');
  });

  test('1000 somas de 0.10 dão exatamente 100.00', () => {
    let total = Money.zero('BRL');
    const dime = brl('0.10');
    for (let i = 0; i < 1000; i++) total = total.add(dime);
    expect(total.toString()).toBe('100.00');
  });
});

describe('moedas', () => {
  test('operações entre moedas diferentes lançam erro', () => {
    const usd = Money.from('1.00', 'USD');
    expect(codeOf(() => brl('1.00').add(usd))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => brl('1.00').subtract(usd))).toBe('CURRENCY_MISMATCH');
    expect(codeOf(() => brl('1.00').isGreaterThan(usd))).toBe('CURRENCY_MISMATCH');
  });

  test('equals considera a moeda', () => {
    expect(brl('1.00').equals(Money.from('1.00', 'USD'))).toBe(false);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
  });
});

describe('comparações', () => {
  test('maior, menor e maior ou igual', () => {
    expect(brl('2.00').isGreaterThan(brl('1.99'))).toBe(true);
    expect(brl('1.99').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isGreaterThanOrEqual(brl('2.00'))).toBe(true);
    expect(brl('1.00').isGreaterThan(brl('1.00'))).toBe(false);
  });

  test('isZero e isPositive', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
  });
});

describe('imutabilidade e serialização', () => {
  test('operações devolvem novas instâncias e não alteram a original', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(a).not.toBe(b);
  });

  test('a instância é congelada', () => {
    const a = brl('10.00');
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { minor: bigint }).minor = 1n;
    }).toThrow();
  });

  test('toJSON usa string com 2 casas (nunca number)', () => {
    expect(JSON.stringify(brl('25.5'))).toBe('{"amount":"25.50","currency":"BRL"}');
  });

  test('ida e volta: from(toString()) preserva o valor', () => {
    for (const v of ['0.00', '0.01', '1.10', '123456.78', '999999999999999.99']) {
      expect(brl(v).toString()).toBe(v);
      expect(Money.from(brl(v).toString(), 'BRL').equals(brl(v))).toBe(true);
    }
  });
});