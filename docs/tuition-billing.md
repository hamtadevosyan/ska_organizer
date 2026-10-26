# Child tuition and payments

Administrators open **More → Tuition** on a phone, or **Tuition** in the desktop menu. The page is titled **Tuition & payments**. A child's profile also links to that child's billing. Other roles cannot read or change the financial pages or APIs.

## Set up tuition

Choose a child and open tuition setup. Enter the billing start/end, the month the rate takes effect, the monthly amount owed by the family and the monthly amount expected from CCRC. Their due days are separate. Enter the actual agreed amounts; the application does not determine CCRC eligibility, reimbursement rates or parent co-payments.

Saving an enabled profile creates missing full-month tuition charges from the billing start through the current facility month, within the billing end date. Existing charged months keep their recorded amounts and due dates when a later rate is saved. There is no automatic partial-month proration: use an explicit charge adjustment when needed. A due day of 29, 30 or 31 uses the last day of a shorter month.

The suggested registration amount is saved for convenience. **Add registration fee** creates the actual one-time charge. A zero registration charge records an explicit waiver with a reason. An additional registration fee requires confirmation; restarting the server or reactivating a child never silently repeats it.

Disabled billing profiles and inactive children receive no new automatic monthly charges. Ending enrollment pauses an existing billing profile, and reactivating the child leaves billing paused. To resume, an administrator explicitly chooses the new billing start and rate and enables monthly billing. Check the displayed catch-up range before saving so inactive months are not unintentionally billed. Earlier charges, payments, credits and overdue balances remain visible. Set the billing end date explicitly when that is part of the agreement.

## Record payments and credits

Select **Record payment**, choose Family or CCRC, enter the actual amount/date and optional method/reference, then select the charge to pay. A partial payment leaves the unpaid balance visible. Money beyond that payer's outstanding amount remains available credit for the same child and payer. Choosing **Leave as credit** records an unapplied receipt.

Use **Apply credit** to allocate an existing credit to an outstanding charge. Family and CCRC credits do not automatically pay each other's balances. Review the displayed allocation before saving.

For an entry mistake, reverse the recorded payment with a reason, then record the correct payment. The original receipt and allocations remain in history. A charge adjustment can increase or reduce an unpaid amount, record a waiver or correct its due date, with a reason. Reverse allocated payments before reducing a charge below the amount already applied.

All amounts use exact integer cents internally and display as dollars. Received money, applied payments, unpaid charges and available credit are shown separately. Recording a payment does not execute a bank transfer or verify bank settlement.

## Overdue reminders

Home shows administrator reminders when an unpaid payer balance reaches **five calendar days after its due date**. A charge due October 1 first appears on October 6, including partially paid balances. The facility time zone controls the date; daylight-saving changes do not shorten or extend the five-day period.

Family and CCRC amounts use their own due dates and reminders. An expected CCRC payment never automatically becomes a family debt. Paying or adjusting the remaining balance resolves the reminder. Stable reminder IDs prevent duplicate entries; earlier unpaid history is preserved.

Reminders refresh on Home while visible, on returning to the page and after payment changes. They are computed from saved balances rather than a temporary browser notification. Native server startup and hourly maintenance catch up missing monthly charges; this also recovers a missed month after downtime. If monthly charges still need generation, the page warns that balances need updating and offers an explicit generation action.

## Reliability and privacy

Changes use a child billing version and request identifier. A stale edit is rejected, and retrying the same save cannot create another payment. Failed transactions roll back the ledger and audit together. The UI keeps an uncertain save available for retry; do not enter it again as a new receipt until its result is checked.

Financial data and drafts are excluded from the service worker's public cache. Signing out, losing session access or leaving the protected app clears protected in-memory content. PostgreSQL migration **029-child-billing** adds a separate child billing table and preserves existing child, attendance and payroll data. Normal database backups include the billing records; no separate payroll key is needed for this feature.

CCRC statement upload and extraction is **SKAO-113**. SKAO-112 provides its payment ledger but does not import files.

## API and validation

Administrator endpoints are under `/api/billing`: summary, `/alerts`, and `/children/:childId`. Child mutations include `/profile`, `/generate`, `/charges`, `/payments`, `/credits`, `/payments/:paymentId/reverse`, and `/charges/:chargeId/adjustments`. Existing session, Origin, CSRF and employee work-access rules apply. Read endpoints never generate charges.

Run `bash scripts/check-update.sh --billing` with the ordinary app stopped to retain backup, migration, native PostgreSQL, client, build, lint and browser/privacy checks while selecting the affected billing suites. A full `bash scripts/check-update.sh` remains available.
