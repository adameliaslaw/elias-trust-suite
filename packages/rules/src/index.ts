// @elias/rules — versioned, effective-date-keyed compliance rule sets where
// every constant carries a primary-source citation. The suite's moat: tax,
// withholding, and ACH parameters are single-sourced, dated, and auditable.

export {
  cite,
  isCited,
  materialize,
  citedLeaves,
  citationAt,
  register,
  lookup,
  resolveByDate
} from './rules.js';
export type { Citation, Cited, Materialized, CitedLeaf, RuleSet } from './rules.js';

export { payrollRuleSet, payrollValues } from './payroll.js';
export type { PayrollParams, PayrollValues, Bracket, FilingStatus } from './payroll.js';

export { ACH_SERVICE_CLASS } from './nacha.js';
export type { AchServiceClasses } from './nacha.js';
