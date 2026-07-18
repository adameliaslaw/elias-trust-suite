# @elias/money

Exact USD money for the Elias Trust Suite. Zero runtime dependencies, strict TypeScript.

> **The rule: no float64 money anywhere.**
> Every dollar amount in every app (`apps/iolta`, `apps/payroll`, `apps/books`,
> `apps/bills`, `apps/billable`) goes through this package. A `number` with a
> decimal point is never a valid way to represent money — not at the edges,
> not "just for display", not in tests.
>
> Why: the source repos were bitten repeatedly by float money — IOLTA #10
> (reconciliation passing with a tolerance that swallowed cent-level drift),
> Payroll's float report totals, Billable's NaN amounts. Floats cannot
> represent most decimal fractions exactly (`0.1 + 0.2 !== 0.3`), so any
> pipeline that touches them eventually misstates a trust account. That is
> not a rounding preference; for IOLTA accounting it is a compliance defect.

## Representation: integer cents in a `bigint`

`Money` stores whole cents — `123456` means `$1,234.56` — inside a `bigint`.
Why bigint instead of a number-safe int:

- **Structurally float-proof.** `bigint` arithmetic with a float is a
  `TypeError` at runtime *and* a type error at compile time. With `number`
  cents, `cents * 1.1` silently produces a float; with bigint it cannot
  compile. The "no float64" rule is enforced by the type system, not by
  code review.
- **No ceiling.** `number` is exact only to 2^53−1 cents (~$90T) — fine in
  practice, but bigint removes even the theoretical question and the need
  for safe-integer guards on every intermediate.
- **Cost:** `bigint` is not JSON-serializable. `toJSON()` emits integer cents
  as a decimal string (e.g. `"123456"`) and `Money.fromJSON()` reads it back.
  Store/transmit cents as strings, never as JSON numbers with decimals.

All operations are exact and immutable; fractional-cent results only arise
from multiplication, where the rounding mode is explicit (default:
half-up, i.e. half away from zero).

## Usage

```ts
import { Money } from '@elias/money';

const deposit = Money.fromDollars('1250.00');   // string only — never Money.fromDollars(1250.5)
const fee = Money.fromCents(35_00);             // or bigint/integer cents
const total = deposit.add(fee);

total.format();        // "$1,285.00"
total.toCents();       // 128500n (bigint)

Money.parse('$1,285.00').equals(total);  // true — parse() is format()'s strict inverse

// Percent / basis-point math, exact rational arithmetic:
Money.fromDollars('200.00').multiplyPercent('7.5');     // $15.00
Money.fromDollars('1000.00').multiplyBasisPoints(50);   // $5.00
Money.fromDollars('10.00').multiply('0.005');           // $0.05 exactly (float64 gives 0.05000...003)
```

## API

| Method | Notes |
|---|---|
| `Money.fromCents(cents)` | bigint \| safe-int number \| integer string. Rejects `1.5`, `NaN`, `Infinity`. |
| `Money.fromDollars(str)` | Strict `"-?digits[.d{1,2}]"`. Rejects sub-cent precision (`"1.005"`) instead of silently rounding. |
| `Money.parse(str)` | Strict inverse of `format()`: optional `$`, correctly-grouped commas. Rejects floats/NaN/garbage. |
| `add` / `subtract` / `negate` / `abs` | Exact, immutable. |
| `multiply(factor, { rounding? })` | Factor: integer or exact decimal **string**. Float factors (`0.1`, `NaN`) are refused. |
| `multiplyPercent(pct)` / `multiplyBasisPoints(bp)` | `"7.5"` = 7.5%; `50` bp = 0.5%. |
| `compare` / `equals` | **Exact.** There is deliberately no tolerance/epsilon — see below. |
| `isZero` / `isNegative` / `isPositive` | |
| `format()` | `"$1,234.56"`, `"-$5.00"`. |
| `toJSON()` / `Money.fromJSON()` | Cents as decimal string. |

## Why `equals` has no tolerance (IOLTA tolerance bug)

A reconciliation in the source IOLTA repo treated cent-level differences as
"close enough". In trust accounting, a 1-cent difference between the book
ledger and the adjusted bank balance is not noise — it is an unreconciled
item, and three-way reconciliation exists to catch exactly that. So
`Money.equals` is exact and there is no `epsilon` parameter anywhere in this
package. If a workflow legitimately needs a materiality threshold, it must
compute the difference explicitly (`a.subtract(b).abs()`) and compare it
against a stated threshold — visible in code, not hidden in equality.

The test suite encodes this: `fromCents(100000).equals(fromCents(100001))`
must be `false`, forever.

## Development

```sh
npm run build       # tsc -> dist/
npm test            # vitest run
npm run typecheck   # strict tsc over src + test
```
