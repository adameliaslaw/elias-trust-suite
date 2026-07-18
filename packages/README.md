# Shared packages

| Package | Purpose |
|---|---|
| money | integer-cents arithmetic, exact equality, formatting — fixes the float bugs found in IOLTA #10, Payroll #15, bankruptcy-app pattern |
| auth | Firebase Auth + rules helpers; fail-closed conventions |
| audit | append-only audit log (hash-chained; satisfies Rule 1:21-6 record-keeping + payroll audit needs) |
| plaid | Plaid client wrapper: token encryption at rest, idempotent requests, /transactions/recurring |
| rules | shared firestore.rules/storage.rules with owner-scoping built in |
