# Shared packages

| Package | Purpose |
|---|---|
| money | integer-cents arithmetic, exact equality, formatting — fixes the float bugs found in IOLTA #10, Payroll #15, bankruptcy-app pattern |
| auth | Firebase Auth + rules helpers; fail-closed conventions |
| audit | append-only audit log (hash-chained; satisfies Rule 1:21-6 record-keeping + payroll audit needs) |
| plaid | Plaid client wrapper: token encryption at rest, idempotent requests, /transactions/recurring |
| rules | **@elias/rules** — versioned, effective-date-keyed compliance rule sets; every constant carries a primary-source citation (IRS Pub 15-T line, N.J.S.A./N.J.A.C. §, SSA/NJ-DOL notice, NACHA spec). Single source of truth for tax/withholding/ACH parameters; payroll retrofitted first (Phase 6 / #25) |
