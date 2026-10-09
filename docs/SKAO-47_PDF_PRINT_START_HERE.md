# SKAO-47 PDF uploads and blank-form printing

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

Print blank form now prepares all pages, then shows a ready preview. Tap **Open print dialog** to choose your printer. The print call runs directly from that tap, after the pages have loaded. Only the selected blank form's page images are printed; the surrounding child profile and checklist are excluded. Tap **Close print preview** when finished. Prepared pages also clear on form/version changes, leaving the component or session expiry.

## Test on your device

1. Upload one of the PDFs that previously failed. Preview it and download it; check that its pages and any completed fields/signatures are preserved.
2. Open a blank template and choose **Print blank form**. Wait for **Ready to print**, then tap **Open print dialog**.
3. Try both a one-page form and a multi-page form. Check that all pages appear in the printer preview and that no child's profile information is included.
4. Cancel the system print dialog, then try again from the ready preview. Close the preview when finished.

The automated browser check verifies real file fetching, PDF rendering, all decoded pages, a live user gesture at the print call and session-expiry cleanup. Headless Chromium cannot verify your iOS printer sheet or physical printer. If the dialog does not open, the app keeps Download blank form available.

No original failing user PDF was supplied. This patch fixes seven reproduced compatibility cases; it cannot yet confirm the cause for each of your files. If one still fails, provide its original blank PDF or download link for a targeted reproduction.

Review, test, commit, push and merge from Ubuntu using your usual workflow. After merging, update the Pi checkout and run:

```bash
bash SKAO.sh update
```

No commit, push, deployment, database change or system setting change was performed by this patch bundle.
