import { describe, expect, it } from 'vitest';
import { toMoney } from '../src/shared/money.js';

describe('toMoney', () => {
  it('formats minor units as a decimal string', () => {
    expect(toMoney(850000n, 'DZD', 2)).toEqual({ currency: 'DZD', amountMinor: 850000, amount: '8500.00' });
    expect(toMoney(5n, 'EUR', 2).amount).toBe('0.05');
    expect(toMoney(1500n, 'JPY', 0).amount).toBe('1500');
    expect(toMoney(1234n, 'KWD', 3).amount).toBe('1.234');
  });
});
