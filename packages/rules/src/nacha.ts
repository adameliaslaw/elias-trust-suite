// NACHA (ACH) service class codes — the cited constants behind the
// direct-deposit and tax-payment file builders. Keeping these here means the
// "a payroll batch is credits-only (220), not mixed (200)" rule lives next to
// its authority, not as a bare literal in a file builder.

import { cite } from './rules.js';
import type { Cited } from './rules.js';

const NACHA_RULES = 'NACHA Operating Rules & Guidelines (2026), Appendix Three: ACH Record Format Specifications';

export interface AchServiceClasses {
  /** Batch contains both debits and credits. */
  readonly MIXED: Cited<string>;
  /** Batch contains credits only (e.g. payroll direct deposit). */
  readonly CREDITS_ONLY: Cited<string>;
  /** Batch contains debits only. */
  readonly DEBITS_ONLY: Cited<string>;
}

/** Service Class Codes for the Company/Batch Header (field 2) and Batch Control (field 2). */
export const ACH_SERVICE_CLASS: AchServiceClasses = {
  MIXED: cite('200', NACHA_RULES, 'Company/Batch Header Record, field 2 — mixed debits and credits'),
  CREDITS_ONLY: cite('220', NACHA_RULES, 'Company/Batch Header Record, field 2 — credits only'),
  DEBITS_ONLY: cite('225', NACHA_RULES, 'Company/Batch Header Record, field 2 — debits only')
};
