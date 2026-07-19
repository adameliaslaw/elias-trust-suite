# Ethics & Billing Posture

Matterproof is designed around **ABA Formal Opinion 512** (July 29, 2024), the
ABA's first ethics guidance on generative AI, and the fee rules it applies
(Model Rules 1.5, 5.1, 5.3). The short version of Op. 512 on fees: **a lawyer
billing hourly may charge only for actual time spent.** If AI drafts in 15
minutes what once took 3 hours, the client may be billed 15 minutes — not the
time "saved." Lawyers also may not bill clients for time spent learning
general-purpose AI tools, and may pass through reasonable AI costs only with
disclosure and client agreement.

Matterproof is built to make honest billing *easier to prove*, not to inflate
it:

## Actual time, contemporaneously recorded

Every entry is derived from timestamped activity captured as it happens —
prompts, AI steps, completions. Idle gaps are capped so away-from-keyboard
time is never counted. Reconstructed time is an ethics risk; a
contemporaneous ledger is the cure.

## Attorney review is a first-class workflow

AI activity becomes a *draft* time entry. The dashboard's review workflow
(`billable serve`) exists so a lawyer examines every entry — adjusting hours,
rewriting narratives, or marking work "no charge" — before anything reaches a
client. Review decisions are stored separately from the raw ledger, so the
original record of what the AI actually did is never altered. That separation
is your supervision record under Rules 5.1/5.3 and your audit trail if a
court, client, or carrier asks how AI was used on a matter.

## Costs are disclosed, not buried

If you pass through AI usage costs (permitted by Op. 512 with disclosure and
consent), Matterproof computes them from **unrounded actual runtime**
(`aiCostPerHour`), reports them as a separate line — never blended into fees —
and exports them as LEDES expense lines. Whether and how to pass costs
through is governed by your engagement agreement.

## Flat fees and unit economics

For flat-fee and hybrid practices (most firms now offer flat fees), the same
ledger answers a different question: what does this matter *cost to produce*?
Nothing in Op. 512 restricts using AI activity records for internal pricing,
profitability, or value-billing conversations with clients.

## What Matterproof will not do for you

- It does not decide what is billable. Rounding minimums and increments are
  conventions you configure; whether a given entry may be billed, and at what
  rate, is a professional-responsibility judgment that stays with you.
- It does not make AI output competent. Op. 512's core duty is competence —
  review the work product, not just the time entry.
- It is not legal or ethics advice. Check your jurisdiction: several state
  bars have issued their own AI guidance, and engagement letters control.

**Rule of thumb: bill your time, disclose the AI's costs, and keep the
receipt. Matterproof is the receipt.**
