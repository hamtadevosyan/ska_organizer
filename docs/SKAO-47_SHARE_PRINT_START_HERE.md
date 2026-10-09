# SKAO-47 final Share / Print follow-up

This patch applies after the SKAO-47 PDF/print follow-up. It replaces the separate Print and Share buttons with one Share / Print action. PDF upload reliability remains a separate known issue in [SKAO-105](https://ska-organizer.atlassian.net/browse/SKAO-105), linked to SKAO-47.

Extract the ZIP, then run from your ska_organizer checkout:

```bash
bash ~/Downloads/SKAO-47-share-print/apply-fix.sh
bash scripts/check-update.sh
```

The apply script checks the whole patch before writing, refuses conflicting local edits and recognizes an already-applied patch. Dependencies, database migrations and server PDF validation are unchanged.

## Test the final workflow

1. Open a saved blank template and choose **Share / Print**.
2. Once the original file is ready, tap **Open share menu**. Choose an available share or Print action in your device's menu. Available actions depend on the device and installed applications.
3. If the browser cannot share files, choose **Download to share or print**, then open that file and use its sharing or printing controls.
4. Cancel the menu once and try again. Cancelling does not automatically share or download the file.
5. Choose **Close share options** when finished. Navigating away, changing the form/version or session expiry also clears the prepared file.

Only the selected blank template is passed to the menu. The original PDF/image bytes and all original pages are preserved; there is no rasterization, hidden print frame, public file URL or child-profile information in this export. Preview and direct Download remain available.

PDF uploads are not claimed to be fully fixed. The user has accepted deferring remaining selective failures to SKAO-105 so SKAO-47 can be completed. This final patch does not change or loosen the PDF validator.

## Commit and deployment

Use your normal Ubuntu review, test, commit, push and merge workflow. After merging to development, pull the latest development code on the Pi and run:

```bash
bash SKAO.sh update
```

Automated tests verify local file fetching, original bytes, native invocation during a live tap, explicit download fallback and session cleanup. A headless browser cannot verify the actual device share sheet, its Print option or physical printing; check those on your phone/iPad.

No commit, push, merge, deployment, database or system-setting change was performed by the patch bundle.
