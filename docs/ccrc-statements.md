# CCRC payment statements

Administrators open **Tuition → Import CCRC statement** to upload and review a payment statement. Financial records, originals, extracted text and import history are restricted to administrators. Ordinary editors, teachers and viewers cannot read them.

## What is supported

Upload one PDF, JPG or PNG of at most **5 MiB**. PDFs can contain up to **12 pages**, and an import supports up to **200 candidate/payment rows**. Photos can contain up to **20 million pixels**, with neither side above **5,000 pixels**, so ordinary 12 MP phone images can retain their original bytes. A text PDF is read page by page; scanned PDF pages and images are read locally with Poppler and Tesseract English OCR. Phone-photo orientation is corrected from EXIF in a temporary OCR copy, and a large photo is resized without cropping its full frame. The original file and its fingerprint stay unchanged. Processing uses bounded local commands and temporary files; it does not send statements to an external AI or OCR service.

The first release recognizes conservative labelled and tabular text patterns and provides a manual review fallback. A representative real CCRC statement has not yet been verified, so recognition of every CCRC layout is not claimed. Amounts, dates, names and identifiers are suggestions to check against the original, even when extraction looks complete. An unreadable or unsupported page stays visible as an issue instead of disappearing from the import.

If text or OCR reading is unavailable, the original remains available for manual review. Enter the missing information from that source and explain the reconciliation. Do not guess a child, payment amount, date, service month or payment reference.

## Prepare the server

Ubuntu and Debian servers, including ARM64 and x86_64, use the same local tools:

```bash
bash scripts/setup-ccrc-ocr.sh
```

The installer installs `poppler-utils`, `tesseract-ocr`, `tesseract-ocr-eng`, `util-linux` for the `prlimit` resource limiter, and Python 3 with `python3-pil` for local photo normalization. It waits for the package manager's normal installation lock and stops on an unsuccessful package refresh. It does not change global execution policies, DNS, firewall, router settings or external OCR credentials. Local reading has a 120-second overall time limit, with memory and CPU limits for each command; a failed or unreadable page needs review rather than being silently omitted.

Migration **030-ccrc-statements** adds a private statement-import table. The original file bytes, extracted pages, draft review, posting references and history are stored in PostgreSQL and included in normal database backups. Previously applied migrations and SKAO-112 child billing records are retained.

## Review before registering payments

1. Use **Choose statement file** or **Take statement photo**, then **Read statement**. Supply the complete statement, including all pages. Uploading creates a draft; it does not record a payment or change a child's balance.
2. Compare each page's extracted text and candidate lines with the original. Download the original when its layout or scan is needed for checking. Mark every page reviewed. If the page count could not be read, declare and check the actual page count rather than assuming one page.
3. Check the statement reference, payment reference, payment date and total. The **payment date** and **month of care** are separate: a payment received in November can pay October tuition. Check a row's own payment date and entry reference when the statement contains different payments or voucher entries.
4. Review every line. Select the correct existing child, service month and actual paid amount. Child-name suggestions never approve a match by themselves. Add a missed line when required; retain an excluded line with its reason instead of silently removing evidence.
5. The included positive payment lines must equal the reviewed statement total exactly, in integer cents. Resolve discrepancies, unclear adjustments and excluded lines with an attributed reconciliation note. Record a net paid amount only when the source explicitly identifies that amount for the correct child and service period. Do not subtract a negative adjustment from an arbitrary child's payment merely to force the totals to match. Clawbacks and negative-only statements require an attributed review of the original payment and the existing correction/reversal workflow; they are not automatically posted as positive payments or parent credits.
6. Use **Save review**. Check **I want to register these reviewed payments**, then use **Confirm and register payments**. Saving a draft alone does not post it.

Only actual statement-reported payments are recorded. An authorization, expected reimbursement or estimated subsidy is not a receipt. Posting does not verify bank settlement, collect money or execute a transfer.

## Service months and parent balances

SKAO-112 stores one monthly tuition fee and uses actual CCRC payments for that service month. An imported receipt is allocated to the corresponding existing charge when appropriate. The importer never creates a tuition charge or silently converts an earlier fixed payer split. Missing or unsuitable charges need an administrator's review; an explicitly unapplied receipt remains a credit with its service-month provenance.

Example: October tuition is $1,200. Two reviewed November CCRC payments of $600 and $400 apply to October. The provisional remainder is $200 before deducting any parent payments. Importing the statement leaves that month awaiting the separate CCRC review, because another receipt may still arrive. Finish the existing monthly CCRC review and choose the parent due date only after the relevant receipts have been checked. The parent-overdue warning starts five calendar days after that confirmed due date.

Receipts exceeding a charge's remaining balance remain explicit CCRC credit. A parent who already paid is not silently refunded, and their payment is not silently reassigned. Review and correct allocations through the existing attributed billing actions.

## Duplicate protection and corrections

The original's SHA-256 fingerprint identifies repeat uploads of identical bytes. Repeat uploads reopen the same saved record rather than creating another receipt. Reviewed payment identities and possible-overlap warnings also protect against differently scanned or rearranged copies of a payment. Resolve uncertain duplicates against the original and existing payment history; an explanation is not permission to repost a confirmed duplicate.

An uncertain network result keeps the same request identifier available for retry. Retry the existing operation rather than entering the payment again. A stale statement or child billing version stops posting and preserves the draft for review. Recheck current balances before saving a new review.

All approved payment lines, their source/page references, the statement's posted state and audit entries commit together. A failure leaves every child's ledger unchanged. Cancelling a draft leaves balances unchanged and retains its private source; a cancelled draft can be reopened for review. Posted records retain their history. Correct an incorrectly posted payment through the existing payment reversal workflow rather than deleting the statement or original receipt.

## Privacy and verification

Original downloads are authenticated, private, non-cacheable attachments. The public service worker caches only verified public application files; it does not cache statement URLs, extracted text, review drafts, originals or payment API responses, and it never queues payment writes while offline. Session loss clears protected in-memory review content and aborts pending requests.

Run with the ordinary app stopped:

```bash
bash scripts/check-update.sh --ccrc
```

This retains the normal database backup, migration, PostgreSQL, build, lint, component, browser and PWA privacy checks while selecting the affected statement and billing suites. A full `bash scripts/check-update.sh` is also available. Native PostgreSQL and a representative redacted real statement should be checked on Ubuntu before production use of a new statement layout.

Administrator APIs are under `/api/billing/statements`. Upload, saved review, explicit posting, cancellation and reopening are separate operations. Existing Origin, CSRF, session, work-access, role and audit rules remain in force.


Setup and update integration: `bash SKAO.sh setup` and `bash SKAO.sh update` now verify Poppler, Tesseract English data and system Pillow automatically before release activation. Missing tools are installed; existing tools skip APT. Package or verification failures stop activation. The image reader and orientation tests support legacy Pillow constants as well as modern enums. No separate OCR setup or manual source edits are required on the Pi. The standalone OCR helper remains available for development test machines.
