# SKAO-47 earlier PDF compatibility follow-up

The app-managed print workflow described in this earlier bundle has been superseded by the combined Share / Print action. Use [SKAO-47_SHARE_PRINT_START_HERE.md](SKAO-47_SHARE_PRINT_START_HERE.md) for the final workflow. Remaining PDF upload failures are deferred to [SKAO-105](https://ska-organizer.atlassian.net/browse/SKAO-105).

Apply this follow-up after the SKAO-47 template-groups update. Keep the browser-session follow-up if you already applied it. This patch does not replace that fix.

Extract the ZIP, open a terminal in your ska_organizer checkout, and run:

```bash
bash ~/Downloads/SKAO-47-pdf-print-fix/apply-fix.sh
bash scripts/check-update.sh
```

The apply script checks the entire patch before writing and refuses to overwrite conflicting local edits. If it says the patch is already applied, continue with the check script. Dependencies and migrations are unchanged; use your existing check-update configuration and separate test database. Existing backups remain available.

## What changed

The PDF upload validator now reads PDF whitespace, comments, escaped names and nested metadata correctly. The previous checks could reject readable PDFs with "The PDF file is damaged or incomplete." The same validator serves blank templates and completed child documents. It stores the original file bytes without rewriting a form or signature.

This is bounded basic file-integrity validation, not a full PDF parser or malware scanner. File-size limits, exact cross-reference offsets, incomplete-file rejection and document permissions remain in place. It does not enable PDF scripts or send files to an external service.

## Current share and print workflow

Choose **Share / Print**, wait for the blank file to be ready, then tap **Open share menu**. Choose an available sharing or printing action in your device's menu. On browsers without file sharing, choose **Download to share or print**, then open the downloaded file.

The original blank file is passed to the device; there is no raster print frame. The user chooses the destination. Actual native menu actions, including Print, depend on the device and installed applications.

Some PDFs still fail to upload. That remaining problem is explicitly deferred to SKAO-105; this earlier compatibility fix did not solve every real-file failure. Further PDF validation work is outside the accepted completion scope of SKAO-47.

Review, test, commit, push and merge from Ubuntu using your usual workflow. After merging, update the Pi checkout and run:

```bash
bash SKAO.sh update
```

No commit, push, deployment, database change or system setting change was performed by this patch bundle.
