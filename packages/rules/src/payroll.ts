// Payroll & withholding rule set — the first domain retrofitted onto the cited
// rule engine. Values were ported from the firm payroll app's single-year
// `tables2026.js`; here each one is bound to the primary source that fixes it,
// keyed by calendar year, so a paycheck figure can always answer "which line
// of which authority says so?" — and adding a new tax year is a new registered
// rule set, not an edit to a shared table.
//
// Figures marked "verify" in a citation note are ported and should be checked
// against the published authority before a live filing; this mirrors the honest
// posture of the household 1040 planner. Nothing here is float money — the
// consuming engine routes every product through @elias/money.

import { cite, materialize, register } from './rules.js';
import type { Cited, Materialized, RuleSet } from './rules.js';

/** A withholding bracket row: [floor, tentativeTaxAtFloor, marginalRate]. */
export type Bracket = [floor: number, taxAtFloor: number, marginalRate: number];

export type FilingStatus = 'married_jointly' | 'single' | 'head_of_household';
type StatusBrackets = Record<FilingStatus, Cited<Bracket[]>>;
type StatusAmounts = Record<FilingStatus, Cited<number>>;
type NjRateTable = 'A' | 'B' | 'C' | 'D' | 'E';
type NjTables = Record<NjRateTable, Cited<Bracket[]>>;

/** The full cited parameter set the payroll engine computes against. */
export interface PayrollParams {
  readonly YEAR: number;
  readonly FED_STANDARD: StatusBrackets;
  readonly FED_CHECKBOX: StatusBrackets;
  readonly FED_W4_ADJUSTMENT: StatusAmounts;
  readonly SOCIAL_SECURITY_RATE: Cited<number>;
  readonly SOCIAL_SECURITY_WAGE_BASE: Cited<number>;
  readonly MEDICARE_RATE: Cited<number>;
  readonly ADDITIONAL_MEDICARE_RATE: Cited<number>;
  readonly ADDITIONAL_MEDICARE_THRESHOLD: Cited<number>;
  readonly FUTA_RATE: Cited<number>;
  readonly FUTA_WAGE_BASE: Cited<number>;
  readonly NJ_ALLOWANCE_ANNUAL: Cited<number>;
  readonly NJ_RATE_TABLES: NjTables;
  readonly NJ_MINIMUM_WAGE: Cited<number>;
  readonly NJ_UI_EMPLOYEE_RATE: Cited<number>;
  readonly NJ_WF_EMPLOYEE_RATE: Cited<number>;
  readonly NJ_UI_WAGE_BASE: Cited<number>;
  readonly NJ_TDI_EMPLOYEE_RATE: Cited<number>;
  readonly NJ_FLI_EMPLOYEE_RATE: Cited<number>;
  readonly NJ_TDI_FLI_WAGE_BASE: Cited<number>;
  /** IRC §402(g)(1) annual elective-deferral limit — new; caps 401(k)/Roth deferrals. */
  readonly ELECTIVE_DEFERRAL_LIMIT_402G: Cited<number>;
}

const PUB_15T = 'IRS Publication 15-T (2026), Percentage Method Tables for Automated Payroll Systems';
const NJ_WT = 'NJ Division of Taxation, NJ-WT — New Jersey Gross Income Tax Instructions for Employers (2026)';
const NJ_DOL = 'NJ Department of Labor & Workforce Development, 2026 contribution rate & taxable wage base notice';
const PORTED = 'Ported from the firm payroll app tables_2026.py; verify against the published source before a live filing.';

const PAYROLL_2026: PayrollParams = {
  YEAR: 2026,

  // Table 1 (Annual payroll period) — Standard Withholding Rate Schedules
  // (W-4 Step 2 checkbox NOT checked).
  FED_STANDARD: {
    married_jointly: cite(
      [[0, 0, 0.0], [19300, 0, 0.1], [44100, 2480, 0.12], [120100, 11600, 0.22],
       [230700, 35932, 0.24], [422850, 82048, 0.32], [531750, 116896, 0.35], [788000, 206583.5, 0.37]],
      PUB_15T, 'Table 1, Annual, Standard, Married Filing Jointly', PORTED),
    single: cite(
      [[0, 0, 0.0], [7500, 0, 0.1], [19900, 1240, 0.12], [57900, 5800, 0.22],
       [113200, 17966, 0.24], [209275, 41024, 0.32], [263725, 58448, 0.35], [648100, 192979.25, 0.37]],
      PUB_15T, 'Table 1, Annual, Standard, Single or Married Filing Separately', PORTED),
    head_of_household: cite(
      [[0, 0, 0.0], [15550, 0, 0.1], [33250, 1770, 0.12], [83000, 7740, 0.22],
       [121250, 16155, 0.24], [217300, 39207, 0.32], [271750, 56631, 0.35], [656150, 191171, 0.37]],
      PUB_15T, 'Table 1, Annual, Standard, Head of Household', PORTED)
  },

  // Table 1 (Annual) — Form W-4, Step 2, Checkbox Withholding Rate Schedules.
  FED_CHECKBOX: {
    married_jointly: cite(
      [[0, 0, 0.0], [16100, 0, 0.1], [28500, 1240, 0.12], [66500, 5800, 0.22],
       [121800, 17966, 0.24], [217875, 41024, 0.32], [272325, 58448, 0.35], [400450, 103291.75, 0.37]],
      PUB_15T, 'Table 1, Annual, Step 2 Checkbox, Married Filing Jointly', PORTED),
    single: cite(
      [[0, 0, 0.0], [8050, 0, 0.1], [14250, 620, 0.12], [33250, 2900, 0.22],
       [60900, 8983, 0.24], [108938, 20512, 0.32], [136163, 29224, 0.35], [328350, 96489.63, 0.37]],
      PUB_15T, 'Table 1, Annual, Step 2 Checkbox, Single or Married Filing Separately', PORTED),
    head_of_household: cite(
      [[0, 0, 0.0], [12075, 0, 0.1], [20925, 885, 0.12], [45800, 3870, 0.22],
       [64925, 8077.5, 0.24], [112950, 19603.5, 0.32], [140175, 28315.5, 0.35], [332375, 95585.5, 0.37]],
      PUB_15T, 'Table 1, Annual, Step 2 Checkbox, Head of Household', PORTED)
  },

  // Subtracted from annual wages when the Step 2 checkbox is NOT checked.
  FED_W4_ADJUSTMENT: {
    married_jointly: cite(12900, PUB_15T, 'Worksheet 1A, Step 1, line 1g (MFJ)', PORTED),
    single: cite(8600, PUB_15T, 'Worksheet 1A, Step 1, line 1g (Single/HoH)', PORTED),
    head_of_household: cite(8600, PUB_15T, 'Worksheet 1A, Step 1, line 1g (Single/HoH)', PORTED)
  },

  SOCIAL_SECURITY_RATE: cite(0.062, 'IRC §3101(a)', 'Employee OASDI tax rate 6.2%'),
  SOCIAL_SECURITY_WAGE_BASE: cite(184500, 'SSA, 2026 Social Security (OASDI) contribution and benefit base',
    'Announced under 42 U.S.C. §430', PORTED),
  MEDICARE_RATE: cite(0.0145, 'IRC §3101(b)(1)', 'Employee Hospital Insurance tax rate 1.45%'),
  ADDITIONAL_MEDICARE_RATE: cite(0.009, 'IRC §3101(b)(2)', 'Additional Medicare Tax rate 0.9% (employee only)'),
  ADDITIONAL_MEDICARE_THRESHOLD: cite(200000, 'IRC §3101(b)(2); Treas. Reg. §31.3102-4',
    'Employer withholds on wages over $200,000, regardless of filing status'),

  FUTA_RATE: cite(0.006, 'IRC §3301; §3302', 'Net FUTA rate 0.6% = 6.0% less the full 5.4% credit (NJ not credit-reduced for 2026)', PORTED),
  FUTA_WAGE_BASE: cite(7000, 'IRC §3306(b)(1)', 'FUTA taxable wage base $7,000'),

  NJ_ALLOWANCE_ANNUAL: cite(1000, NJ_WT, 'Withholding allowance value, $1,000 per Form NJ-W4 allowance (annual)'),

  // NJ-WT percentage method, Annual payroll period, Rate Tables A–E.
  NJ_RATE_TABLES: {
    A: cite(
      [[0, 0, 0.015], [20000, 300, 0.02], [35000, 600, 0.039], [40000, 795, 0.061],
       [75000, 2930, 0.07], [500000, 32680, 0.099], [1000000, 82180, 0.118]],
      NJ_WT, 'Rate Table A, Annual payroll period', PORTED),
    B: cite(
      [[0, 0, 0.015], [20000, 300, 0.02], [50000, 900, 0.027], [70000, 1440, 0.039],
       [80000, 1830, 0.061], [150000, 6100, 0.07], [500000, 30600, 0.099], [1000000, 80100, 0.118]],
      NJ_WT, 'Rate Table B, Annual payroll period', PORTED),
    C: cite(
      [[0, 0, 0.015], [20000, 300, 0.023], [40000, 760, 0.028], [50000, 1040, 0.035],
       [60000, 1390, 0.056], [150000, 6430, 0.066], [500000, 29530, 0.099], [1000000, 79030, 0.118]],
      NJ_WT, 'Rate Table C, Annual payroll period', PORTED),
    D: cite(
      [[0, 0, 0.015], [20000, 300, 0.027], [40000, 840, 0.034], [50000, 1180, 0.043],
       [60000, 1610, 0.056], [150000, 6650, 0.065], [500000, 29400, 0.099], [1000000, 78900, 0.118]],
      NJ_WT, 'Rate Table D, Annual payroll period', PORTED),
    E: cite(
      [[0, 0, 0.015], [20000, 300, 0.02], [35000, 600, 0.058], [100000, 4370, 0.065],
       [500000, 30370, 0.099], [1000000, 79870, 0.118]],
      NJ_WT, 'Rate Table E, Annual payroll period', PORTED)
  },

  NJ_MINIMUM_WAGE: cite(15.92, 'NJ Dept. of Labor, minimum wage effective Jan. 1, 2026; N.J.S.A. 34:11-56a4',
    'Most employers; used only to warn on sub-minimum hourly rates', PORTED),

  NJ_UI_EMPLOYEE_RATE: cite(0.003825, NJ_DOL, 'Unemployment Insurance, worker share (2026)', PORTED),
  NJ_WF_EMPLOYEE_RATE: cite(0.000425, NJ_DOL, 'Workforce Development / Supplemental Workforce, worker share (2026)', PORTED),
  NJ_UI_WAGE_BASE: cite(44800, NJ_DOL, 'UI/WF/SWF taxable wage base, employee & employer (2026)', PORTED),
  NJ_TDI_EMPLOYEE_RATE: cite(0.0019, NJ_DOL, 'Temporary Disability Insurance, worker share (2026)', PORTED),
  NJ_FLI_EMPLOYEE_RATE: cite(0.0023, NJ_DOL, 'Family Leave Insurance, worker share (2026)', PORTED),
  NJ_TDI_FLI_WAGE_BASE: cite(171100, NJ_DOL, 'Employee TDI/FLI taxable wage base (2026)', PORTED),

  ELECTIVE_DEFERRAL_LIMIT_402G: cite(24500, 'IRC §402(g)(1); IRS Notice 2025-67 (2026 COLA-adjusted limits)',
    'Annual elective-deferral limit for 401(k)/403(b)/457(b) (under age 50; catch-up not modeled)', PORTED)
};

const REGISTERED = new Map<number, RuleSet<PayrollParams>>();

function registerPayroll(rs: RuleSet<PayrollParams>): void {
  register(rs);
  REGISTERED.set(rs.year, rs);
}

registerPayroll({
  domain: 'payroll',
  jurisdiction: 'US-NJ',
  year: 2026,
  effectiveDate: '2026-01-01',
  params: PAYROLL_2026
});

/**
 * The cited payroll rule set for a calendar year. Throws with an actionable
 * message for an unregistered year — the same fail-closed posture the engine
 * relied on when tables were hardcoded.
 */
export function payrollRuleSet(year: number): RuleSet<PayrollParams> {
  const rs = REGISTERED.get(year);
  if (!rs) {
    throw new Error(
      `No payroll rule set for ${year}. Add a cited PayrollParams for that year in ` +
      '@elias/rules (packages/rules/src/payroll.ts) and register it.'
    );
  }
  return rs;
}

/** Plain payroll parameters (citations stripped), the shape the engine consumes. */
export type PayrollValues = Materialized<PayrollParams>;

const VALUES_CACHE = new Map<number, PayrollValues>();

/**
 * The payroll parameters for a year as plain values — citations stripped,
 * memoized. This is the drop-in replacement for the old hardcoded tables
 * object: identical keys and numbers, now sourced from the cited rule set.
 */
export function payrollValues(year: number): PayrollValues {
  let v = VALUES_CACHE.get(year);
  if (!v) {
    v = materialize(payrollRuleSet(year).params);
    VALUES_CACHE.set(year, v);
  }
  return v;
}
