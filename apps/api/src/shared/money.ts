export type Money = {
  currency: string;
  /** Integer amount in the currency's minor unit (e.g. centimes). */
  amountMinor: number;
  /** Decimal string for display, e.g. "8500.00". */
  amount: string;
};

export function toMoney(amountMinor: bigint, currency: string, minorUnits: number): Money {
  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds safe integer range');
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const factor = 10n ** BigInt(minorUnits);
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(minorUnits, '0');
  const amount = `${negative ? '-' : ''}${whole}${minorUnits > 0 ? `.${fraction}` : ''}`;
  return { currency, amountMinor: Number(amountMinor), amount };
}
