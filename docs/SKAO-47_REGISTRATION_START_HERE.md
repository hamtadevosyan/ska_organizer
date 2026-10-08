# SKAO-47 — registration packet follow-up

This adds an admin-managed catalog of blank registration forms and a checklist
on every child profile. Use your facility's actual packet: medical history,
insurance, emergency contacts, agreements and other forms you require.

## Apply on your Ubuntu development checkout

Extract `SKAO-47-registration-checklist.zip` into Downloads. Stop the normal
client/server and run from the repository root, on your existing SKAO-47 branch:

```bash
bash ~/Downloads/SKAO-47-registration-checklist/apply-fix.sh &&
npm --prefix client ci &&
bash scripts/check-update.sh &&
npm --prefix client run test:pwa &&
npm --prefix client run test:browser:pwa
```

The incremental patch is based on the applied SKAO-47 files with the PostgreSQL
restore and client test follow-ups. It supports an uncommitted checkout,
preserves unrelated edits, checks compatibility before applying, and performs
no commit, push, deployment or system setting changes. Reapplying is a no-op.

The checker creates and verifies a private database backup before migration
018 adds the template and review data. Existing child files remain unassigned
to a registration requirement until you explicitly link them. Their files and
history are preserved. Continue using the existing separate `_test` database;
no database-creation privileges are required by the document archive checks.

## Set up your blank packet once

1. Sign in as an administrator. Open **Registration forms** from the sidebar
   or the phone's **More** menu.
2. Choose **Add blank form**, give it a title/category and optional instructions,
   set **Required for registration** as appropriate, and upload a blank PDF,
   JPG or PNG, up to 5 MB. Use blank templates without any child's information.
3. Repeat for your actual facility packet. An empty catalog does not report
   registration as complete. Optional forms are shown without blocking the
   required-form completion count.
4. Use **Edit template details** to rename a form, change its instructions or
   required status. To change the form itself, edit your blank original with
   your preferred document editor, then use **Upload new blank version**.
5. New required forms automatically appear as missing on existing child
   checklists. A new blank version marks an older submitted copy **Updated
   form needed**. Earlier blank and completed versions remain accessible.
   Archiving a template removes it from the current packet and preserves its
   history. The system does not monitor regulation changes for you; an admin
   uploads or updates the facility packet when needed.

## Register a child

1. Add a fictional child for testing. **Add documents after saving** is checked
   by default, so the saved child's profile opens on its registration checklist.
   Failed or cancelled child creation cannot attach files to an unsaved child.
2. Missing forms offer **Preview**, **Download**, **Print** and **Share** for
   the blank template. Print shows only that blank form. Sharing uses your
   device's share sheet when supported; otherwise it downloads the blank file
   for you to share. These actions do not send a child's completed documents.
3. Choose **Attach completed copy** on a requirement. The document title,
   category and current blank version are selected. Upload or capture the
   completed form and save it. It shows **Needs review**.
4. Open **Review completed copy**, preview the saved file, check that it is
   filled out and signed where required, then acknowledge that check and
   choose **Mark reviewed**. The required count updates to **Complete**.
5. For a previously saved unassigned document, use **Edit document details**
   to link it to the correct current registration form, confirm its version,
   save, and review it. A new child-file version clears its previous review.
6. Upload a new blank version as admin. Refresh the child documents and confirm
   **Updated form needed**. Attach and review the newly completed copy;
   simply retaining the older copy does not satisfy the updated requirement.
7. Add another required template and verify it appears **Missing** for the
   existing child. Test an optional form and archiving/restoring a template.

A file upload alone does not prove a signature or complete answers: administrators
review the current completed copy. The checklist tracks packet completion
separately from active enrollment and attendance. Configure your actual
facility requirements before relying on the completion count.

## Permissions, persistence and device checks

Only administrators can manage templates, read checklists or files, attach
completed copies and review them. Teacher/editor and read-only accounts see no
documentation section and cannot access files or checklists, including when an
older version stored a document grant for them.

Templates, their immutable bytes, completed copies, mappings and review records
are stored in PostgreSQL and included in native database backups. New pilot
backup manifests use format 3; older format 1/2 backups remain readable.
The existing restart check also verifies the registration data:

```bash
npm --prefix server run test:restart:prepare
```

Restart only the disposable test PostgreSQL instance, then:

```bash
npm --prefix server run test:restart:verify
```

After automated checks, try preview, print, download and sharing on the actual
iPhone/iPad through your existing HTTPS app address. Browser print/share support
varies; downloading remains available. Test with fictional paperwork.

After acceptance, stage the SKAO-47 changes, commit on the development machine,
push your branch and merge your PR. The Pi continues to pull merged development
code and run `bash SKAO.sh update`.
