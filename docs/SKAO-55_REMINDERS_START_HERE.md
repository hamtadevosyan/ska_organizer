# SKAO-55 — expiration suggestions and upload reminders

Apply this update on your Ubuntu development checkout after the current SKAO-55 employee-document changes. It includes the new upload workflow; it does not commit, push, deploy or change system settings. Keep SKAO-55 In Progress until you test and merge.

## Apply and check

Extract `SKAO-55-upload-reminders.zip`, then run from your `ska_organizer` repository:

```bash
bash ~/Downloads/SKAO-55-upload-reminders/apply-fix.sh
git diff --stat
bash scripts/check-update.sh
```

Stop your normal development servers before the check-update script. The existing script backs up your database, verifies migrations and runs server, client and browser checks. Retain its backup if a check fails. No new dependency, migration or operating-system package is added by this patch; local OCR uses the Tesseract installation already used for recipe photos. Without OCR, enter the expiration date manually.

If patch application reports a mismatch, it leaves files unchanged. Inspect the named paths and local edits; do not discard your database, configuration or unrelated work to force application.

For focused development checks:

```bash
npm --prefix server test -- --runInBand staffDocumentOcr
npm --prefix client test -- StaffDocuments staffDocumentExpiration staffDocumentOcr pdfStandardFonts
npm --prefix client run test:browser -- staff-upload-reminders.spec.ts staff-compliance.spec.ts
npm --prefix client run build
```

## Try the upload flow

1. As administrator, open Staff → Documents & training and attach a required employee certificate.
2. Select a PDF/photo. For camera capture, confirm the photo first. The app reads supported text using your device and local server.
3. If it suggests an expiration date, check the original document and choose **Use expiration date**. The date is not filled automatically. If no clear date is found, enter it yourself, or select **Does not expire** when the requirement allows it.
4. Choose **Remind me**: facility default, a preset or a custom number of days. Check the displayed reminder date. Save the document and review its current evidence.
5. Reopen the saved document and verify its date and reminder. Try renewal: enter/confirm the new copy's date; the previous file/date stay in history.
6. On Home/Staff, admins and editors receive summaries for required documents on active employees. Editors cannot read private files or change reminders; read-only users cannot access them.

Detection helps with entry and needs confirmation. Ambiguous date formats, poor photos and unsupported PDFs need manual entry. Only the first five PDF pages are checked, and a partial check is indicated. The reminders appear inside the app; this does not send emails or phone notifications.

## Commit and deploy after your checks

Review the paths listed in `FILES.txt`, commit them on your development machine and push/merge as usual. Your Pi then pulls the merged development branch and runs:

```bash
bash SKAO.sh update
```

The separate remaining PDF compatibility bug is SKAO-105. The prior full-suite attendance-input failure in the local managed browser runtime remains documented in the browser-login follow-up; this patch does not claim to fix it.
