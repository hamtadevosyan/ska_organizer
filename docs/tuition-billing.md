# Child tuition and payments

Administrators open **More → Tuition** on a phone, or **Tuition** in the desktop menu. The page is titled **Tuition & payments**. A child's profile also links to that child's billing. Other roles cannot read or change the financial pages or APIs.

## Set up tuition

Choose a child and open tuition setup. Enter **one monthly tuition fee**, the billing start/end, the month the rate takes effect and the ordinary parent due day. Mark whether the child receives CCRC support. Do not enter an estimated or fixed monthly CCRC amount: the actual payment can differ each month. The application does not determine CCRC eligibility or reimbursement rates.

Saving an enabled profile creates missing full-month tuition charges from the billing start through the current facility month, within the billing end date. Existing charged months keep their recorded amounts and due dates when a later rate is saved. There is no automatic partial-month proration: use an explicit charge adjustment when needed. A due day of 29, 30 or 31 uses the last day of a shorter month.

The suggested registration amount is saved for convenience. **Add registration fee** creates the actual one-time charge. A zero registration charge records an explicit waiver with a reason. An additional registration fee requires confirmation; restarting the server or reactivating a child never silently repeats it.

Disabled billing profiles and inactive children receive no new automatic monthly charges. Ending enrollment pauses an existing billing profile, and reactivating the child leaves billing paused. To resume, an administrator explicitly chooses the new billing start and rate and enables monthly billing. Check the displayed catch-up range before saving so inactive months are not unintentionally billed. Earlier charges, payments, credits and overdue balances remain visible. Set the billing end date explicitly when that is part of the agreement.

## Record payments and credits

Select **Record payment**, choose Family or CCRC, enter the actual amount/date and optional method/reference, then select the charge and service month to pay. The payment date is separate from the month of care: a November receipt can pay October tuition. A partial payment leaves the unpaid balance visible. Money beyond the charge's available balance remains explicit credit for the same child and payer; it does not silently pay another month. Choosing **Leave as credit** records an unapplied receipt.

Use **Apply credit** to allocate an existing credit to an outstanding charge. Family and CCRC credits do not automatically pay each other's balances. Review the displayed allocation before saving.

For an entry mistake, reverse the recorded payment with a reason, then record the correct payment. The original receipt and allocations remain in history. A charge adjustment can increase or reduce an unpaid amount, record a waiver or correct its due date, with a reason. Reverse allocated payments before reducing a charge below the amount already applied.

All amounts use exact integer cents internally and display as dollars. Received money, applied payments, unpaid charges and available credit are shown separately. Recording a payment does not execute a bank transfer or verify bank settlement.

## CCRC payments and the parent remainder

For a CCRC-supported month, the full tuition charge starts as **Awaiting CCRC**. Its remaining amount is provisional, and no parent-overdue reminder is produced while the CCRC review is pending. There is no invented CCRC receivable or automatic deadline based on the receipt's month.

Example: October tuition is $1,200. CCRC pays $600 and then $400 during November. Record both receipts against **October**. The app shows $1,000 from CCRC and a $200 remaining balance. After checking that the relevant CCRC payments are complete, confirm the parent balance and choose the parent's due date. Parent payments already allocated to that month also reduce the remainder. If CCRC paid nothing, an administrator can explicitly review that outcome rather than pretending a payment was received.

Additional CCRC receipts or allocations, a reversal of a targeted CCRC payment or a tuition correction reopen the CCRC review. The original receipts and review history remain visible. Parent payments after confirmation reduce the reviewed balance without resetting its due date. Unapplied credits do not count as payments for that service month until explicitly allocated.

If parents already paid the whole month, a later CCRC receipt still retains its service-month reference and remains unapplied CCRC credit. The page distinguishes money received from money applied and requires review of that credit before confirming the parent balance. It never silently converts a CCRC overpayment into a parent refund or moves an earlier parent payment. Resolve any necessary correction with the attributed payment reversal and allocation actions; the application does not execute refunds.

Earlier fixed-split records retain their recorded history. Updating a profile affects newly generated months, not old charges. An administrator must explicitly convert an earlier monthly charge to actual-CCRC review if appropriate; this is not an automatic rewrite of paid history.

## Overdue reminders

Home shows administrator reminders when an unpaid payer balance reaches **five calendar days after its due date**. A charge due October 1 first appears on October 6, including partially paid balances. The facility time zone controls the date; daylight-saving changes do not shorten or extend the five-day period.

For a CCRC-supported month, the five-day parent reminder starts from the **parent due date chosen after CCRC review**, not from the original tuition month or the CCRC receipt date. A confirmed parent balance due November 25 first produces an overdue reminder on November 30. Ordinary family-only tuition uses its saved due date. Earlier fixed-split charges retain their original payer dates until explicitly corrected. Paying or adjusting the remaining balance resolves the reminder. Stable reminder IDs prevent duplicate entries; earlier unpaid history is preserved.

Reminders refresh on Home while visible, on returning to the page and after payment changes. They are computed from saved balances rather than a temporary browser notification. Native server startup and hourly maintenance catch up missing monthly charges; this also recovers a missed month after downtime. If monthly charges still need generation, the page warns that balances need updating and offers an explicit generation action.

## Reliability and privacy

Changes use a child billing version and request identifier. A stale edit is rejected, and retrying the same save cannot create another payment. Failed transactions roll back the ledger and audit together. The UI keeps an uncertain save available for retry; do not enter it again as a new receipt until its result is checked.

Financial data and drafts are excluded from the service worker's public cache. Signing out, losing session access or leaving the protected app clears protected in-memory content. PostgreSQL migration **029-child-billing** adds a separate child billing table and preserves existing child, attendance and payroll data. Normal database backups include the billing records; no separate payroll key is needed for this feature.

Use **Tuition → Import CCRC statement** to upload a private PDF or image, review its extracted pages and payment lines, and explicitly register the actual receipts. See [CCRC payment statements](ccrc-statements.md) for local reading, manual fallback, duplicate protection and source history. Importing receipts leaves the separate monthly CCRC review pending until the administrator confirms that month's parent balance and due date.

## API and validation

Administrator endpoints are under `/api/billing`: summary, `/alerts`, and `/children/:childId`. Child mutations include `/profile`, `/generate`, `/charges`, `/payments`, `/credits`, `/payments/:paymentId/reverse`, `/charges/:chargeId/adjustments`, `/charges/:chargeId/ccrc-mode` and `/charges/:chargeId/ccrc-review`. Existing session, Origin, CSRF and employee work-access rules apply. Read endpoints never generate charges. A new profile supplies `monthlyCents`, `ccrcManaged` and `familyDueDay`; old fixed-split profiles and charges remain readable until explicitly updated. `awaitingCcrcCents` is an unresolved tuition balance, not an estimate of what CCRC will pay.

Run `bash scripts/check-update.sh --billing` with the ordinary app stopped to retain backup, migration, native PostgreSQL, client, build, lint and browser/privacy checks while selecting the affected billing suites. A full `bash scripts/check-update.sh` remains available.
