// Tax parameters for calendar year 2026.
// Ported from the firm payroll app (payroll/taxes/tables_2026.py); every
// number there is dated and sourced:
// - IRS Publication 15-T (2026), Percentage Method Tables for Automated
//   Payroll Systems (annual amounts).
// - SSA: 2026 Social Security taxable wage base ($184,500).
// - NJ Division of Taxation, NJ-WT percentage-method tables A-E (annual).
// - NJ Dept. of Labor 2026 contribution rates and wage bases.
//
// Each new tax year: copy to tables<year>.js, update values from those
// sources, and register the year in lib/payroll/engine.js (TABLES_BY_YEAR).

module.exports = {
  YEAR: 2026,

  // Bracket rows: [floor, tentativeTaxAtFloor, marginalRate]
  // "Standard Withholding Rate Schedules" — W-4 Step 2 checkbox NOT checked.
  FED_STANDARD: {
    married_jointly: [
      [0, 0, 0.00],
      [19300, 0, 0.10],
      [44100, 2480, 0.12],
      [120100, 11600, 0.22],
      [230700, 35932, 0.24],
      [422850, 82048, 0.32],
      [531750, 116896, 0.35],
      [788000, 206583.50, 0.37]
    ],
    single: [
      [0, 0, 0.00],
      [7500, 0, 0.10],
      [19900, 1240, 0.12],
      [57900, 5800, 0.22],
      [113200, 17966, 0.24],
      [209275, 41024, 0.32],
      [263725, 58448, 0.35],
      [648100, 192979.25, 0.37]
    ],
    head_of_household: [
      [0, 0, 0.00],
      [15550, 0, 0.10],
      [33250, 1770, 0.12],
      [83000, 7740, 0.22],
      [121250, 16155, 0.24],
      [217300, 39207, 0.32],
      [271750, 56631, 0.35],
      [656150, 191171, 0.37]
    ]
  },

  // "Form W-4, Step 2, Checkbox" schedules — checkbox IS checked.
  FED_CHECKBOX: {
    married_jointly: [
      [0, 0, 0.00],
      [16100, 0, 0.10],
      [28500, 1240, 0.12],
      [66500, 5800, 0.22],
      [121800, 17966, 0.24],
      [217875, 41024, 0.32],
      [272325, 58448, 0.35],
      [400450, 103291.75, 0.37]
    ],
    single: [
      [0, 0, 0.00],
      [8050, 0, 0.10],
      [14250, 620, 0.12],
      [33250, 2900, 0.22],
      [60900, 8983, 0.24],
      [108938, 20512, 0.32],
      [136163, 29224, 0.35],
      [328350, 96489.63, 0.37]
    ],
    head_of_household: [
      [0, 0, 0.00],
      [12075, 0, 0.10],
      [20925, 885, 0.12],
      [45800, 3870, 0.22],
      [64925, 8077.50, 0.24],
      [112950, 19603.50, 0.32],
      [140175, 28315.50, 0.35],
      [332375, 95585.50, 0.37]
    ]
  },

  // Pub 15-T Worksheet 1A, line 1g: subtracted from annual wages when the
  // Step 2 checkbox is NOT checked.
  FED_W4_ADJUSTMENT: {
    married_jointly: 12900,
    single: 8600,
    head_of_household: 8600
  },

  SOCIAL_SECURITY_RATE: 0.062,          // employee and employer, each
  SOCIAL_SECURITY_WAGE_BASE: 184500,
  MEDICARE_RATE: 0.0145,                // employee and employer, each
  ADDITIONAL_MEDICARE_RATE: 0.009,      // employee only
  ADDITIONAL_MEDICARE_THRESHOLD: 200000,

  FUTA_RATE: 0.006,   // 6.0% less the full 5.4% credit (NJ not credit-reduced)
  FUTA_WAGE_BASE: 7000,

  NJ_ALLOWANCE_ANNUAL: 1000,  // per allowance claimed on Form NJ-W4

  // NJ-WT percentage method, ANNUAL payroll period tables.
  NJ_RATE_TABLES: {
    A: [
      [0, 0, 0.015],
      [20000, 300, 0.020],
      [35000, 600, 0.039],
      [40000, 795, 0.061],
      [75000, 2930, 0.070],
      [500000, 32680, 0.099],
      [1000000, 82180, 0.118]
    ],
    B: [
      [0, 0, 0.015],
      [20000, 300, 0.020],
      [50000, 900, 0.027],
      [70000, 1440, 0.039],
      [80000, 1830, 0.061],
      [150000, 6100, 0.070],
      [500000, 30600, 0.099],
      [1000000, 80100, 0.118]
    ],
    C: [
      [0, 0, 0.015],
      [20000, 300, 0.023],
      [40000, 760, 0.028],
      [50000, 1040, 0.035],
      [60000, 1390, 0.056],
      [150000, 6430, 0.066],
      [500000, 29530, 0.099],
      [1000000, 79030, 0.118]
    ],
    D: [
      [0, 0, 0.015],
      [20000, 300, 0.027],
      [40000, 840, 0.034],
      [50000, 1180, 0.043],
      [60000, 1610, 0.056],
      [150000, 6650, 0.065],
      [500000, 29400, 0.099],
      [1000000, 78900, 0.118]
    ],
    E: [
      [0, 0, 0.015],
      [20000, 300, 0.020],
      [35000, 600, 0.058],
      [100000, 4370, 0.065],
      [500000, 30370, 0.099],
      [1000000, 79870, 0.118]
    ]
  },

  // NJ minimum wage for most employers, effective Jan 1, 2026 (NJ DOL).
  // Used only to warn when an hourly rate is set below it.
  NJ_MINIMUM_WAGE: 15.92,

  // 2026 employee contribution rates (NJ Dept. of Labor)
  NJ_UI_EMPLOYEE_RATE: 0.003825,   // unemployment insurance, worker share
  NJ_WF_EMPLOYEE_RATE: 0.000425,   // Workforce Development / SWF
  NJ_UI_WAGE_BASE: 44800,          // employee and employer UI/WF/SWF base
  NJ_TDI_EMPLOYEE_RATE: 0.0019,    // temporary disability, worker share
  NJ_FLI_EMPLOYEE_RATE: 0.0023,    // family leave insurance (worker only)
  NJ_TDI_FLI_WAGE_BASE: 171100     // employee TDI/FLI base
};
