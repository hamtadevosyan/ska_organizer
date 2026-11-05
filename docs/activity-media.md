# Pictures and video links for AI activity ideas

This update connects activity pictures to Organizer. The earlier SD1.5 and SDXL
downloads tested pictures on the Windows laptop only. Those tests did not add
pictures to the app.

## Enable it on the existing AI laptop

Use the protected Windows AI account that already runs Ollama and the HTTPS
gateway. Keep the existing models, AI settings and certificates. This installer
uses the SDXL Base checkpoint from the completed comparison; it downloads no
new model or runtime.

Download `Setup-SKAO-ActivityMedia.ps1` to that account's Downloads folder. In its
PowerShell SSH session, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityMedia.ps1"
```

If the download is on your other computer, copy it first using your existing
SSH account and laptop name/address. Replace the two capitalized placeholders:

```powershell
scp "$HOME\Downloads\Setup-SKAO-ActivityMedia.ps1" AI_ACCOUNT@AI_LAPTOP:Downloads/Setup-SKAO-ActivityMedia.ps1
```

Setup adds the `SKAO Activity Images` scheduled task. Enter the AI account's
Windows password in the script's secure prompt if requested. The password is
needed to run the new task when you are signed out; do not put it in a command,
configuration file or chat. Task and firewall changes require an elevated
Windows session. If the SSH session lacks that permission, run the same command
from an elevated PowerShell session under the same AI account on the laptop.

The script checks the existing installation before changing it. A recognized
gateway is backed up, updated and restarted; the existing Pi address, laptop
address, bearer token, certificate, Ollama task and model settings are retained.
An unfamiliar configuration is left alone with a specific error. Repeat setup
adopts a matching installation instead of registering duplicate tasks.

To check afterward without changing configuration or starting image inference:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityMedia.ps1" -Check
```

Keep the laptop awake and connected while using AI. The setup check verifies the
local worker and gateway profile; an authenticated request from Organizer on
the Pi verifies the complete connection, because the gateway only accepts the
configured Pi address.

## Update Organizer on the Pi

Apply and commit the source package in the Organizer Git checkout first. Follow
the package's `START_HERE.md` and `APPLY.sh` / `APPLY.ps1`; copying the Windows
download alone does not update Organizer.

After those changes reach the Pi's checkout, run the normal update there:

```bash
bash SKAO.sh update
```

The normal update backs up the database and applies migration 032. That
migration adds picture storage and an empty picture list for existing
activities. The private AI connection uses the same six `SKAO_AI_*` settings;
there is no new token, IP address or certificate to copy to the Pi.

## Use pictures

1. Open Activities, choose a room, and open **AI activity ideas**.
2. Create the written ideas as usual.
3. Under the idea you want, choose **Create step pictures**. Pictures are optional
   and may take several minutes on the P3200. Progress appears beside that idea.
4. Review each picture against its caption. You can cancel, retry, or continue
   with the written activity only.
5. Choose **Review idea**, remove any incorrect pictures, and save the activity.
6. Add the saved activity to a plan when you want to schedule it. Saving the idea
   alone does not change the week or inventory.

Pictures are illustrations made from the current activity's actual steps. The
app does not substitute the colored-block benchmark pictures for unrelated
activities. General illustrations can still get objects, actions, quantities
and positions wrong. They require adult review; they are not verified teaching
instructions. This first app connection uses SDXL text prompts, rather than
the fixed block-layout guidance from the benchmark.

Changing an activity's name or instructions removes its attached draft pictures
from the form so old pictures cannot be saved against changed instructions.
Generate a fresh idea and pictures when you need a new sequence. Other edits,
such as minutes or inventory links, can keep the matching pictures.

Saved pictures remain with the activity and with existing saved-plan snapshots,
even if the activity is later changed. Assigned classroom viewers can view
pictures in their saved class plans. Pictures are included in database backups.
Use **Print** to prepare saved pictures before printing; wait for preparation
to finish. Unsaved pictures expire after 24 hours and preview limits prevent an
unbounded queue of generated files.

## Use video links

Leave **Include how-to video links** checked when creating ideas. A matching
curated tutorial appears when available. Otherwise the idea gets a clearly
labeled **YouTube search** link. That link opens search results for the activity;
it is not a verified video recommendation. Review the result before using it.

External websites load only when you choose a link. Search uses the generic
activity name, not child names, room records, employee details or inventory.
Planning references describe the source material used for the written idea;
they are separate from tutorial links and are hidden when there are none.

## Privacy and daily laptop use

The Pi sends the generic activity name and step text to the laptop through the
existing authenticated, certificate-verified HTTPS connection. It receives job
progress and PNG pictures. Account identifiers and the full activity description
are not sent to the image worker. Avoid entering personal information in themes
or instructions, because text you deliberately supply can become prompt text.

The browser receives pictures through Organizer after its normal permission
checks. It never receives the private laptop token or connects to ComfyUI.
Ollama and the image worker listen on localhost; raw ports 11434, 11435 and 8188
remain blocked remotely. Only the configured Pi can use HTTPS port 8443.

The idle worker does not load a GPU model. Text and image jobs share one gate,
and images are created one at a time. The owned image process stops when the
job finishes or is cancelled. Running images still uses GPU, CPU and memory and
may affect other laptop work; low process priority does not make it invisible.
Use the picture button when the laptop can spare that work.

If pictures are unavailable, the written idea can still be saved. Check that the
laptop is awake, run the Windows `-Check` command above, then choose **Check
picture connection** in Organizer. A busy response means another AI request is
using the shared worker; wait for it to finish. Do not reinstall models, open raw
ports or disable certificate checks to resolve a connection error.

## Source and validation

The source contains the app API, database migration, protected Windows worker,
gateway upgrade, installer and tests. Build the standalone download with:

```bash
python3 scripts/local-ai/build-activity-media.py --output Setup-SKAO-ActivityMedia.ps1
```

The existing image-test script remains useful for benchmarks and comparisons.
Fresh repository-based Windows setup can use `Setup-LocalAI.ps1 -ActivityImages`;
the standalone media installer above is intended for the already working laptop.

Automated checks cover synthetic image jobs, saving/reloading, ownership,
classroom scope, cancellation, PNG checks, private HTTP/HTTPS contracts, gateway
configuration and small-screen layout. Native Windows task/firewall deployment
and P3200 generation must still be verified on the laptop. The PostgreSQL suites
include migration and BLOB persistence checks and run against a separate test
database in the normal update workflow.

### Windows null package compatibility correction

The media installer now accepts an explicitly present `Package: null` returned
by the Windows firewall provider, as well as the existing scalar `Any` value.
Microsoft's [FW_RULE specification](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fasp/8c008258-166d-46d4-9090-f2ffaa01be4b)
defines a null package condition as applying to all processes. This corrects the
validator; it does not require changing the working firewall rules. Package
SIDs, missing properties and malformed values are still rejected. The correction
covers the Ollama block, gateway allow rule and both image-port blocks.

If the earlier media setup stopped at this check, replace the downloaded
`Setup-SKAO-ActivityMedia.ps1` with the corrected version and run the same setup
command again. Existing keys, certificates, model files, configuration and tasks
are reused. The source package includes a correction-only patch for checkouts
that already received the original media integration.

Activity and picture generation now show a [little thinker loading animation](loading-animation.md) in a dedicated visible waiting panel. Pause animation keeps the job running; Cancel picture generation stops it. Reduce Motion starts with a still picture and offers Play animation. The picture progress bar uses actual completed steps. Activity ideas wait and retry an explicit busy rejection for up to two minutes; Stop AI generation cancels that wait.
