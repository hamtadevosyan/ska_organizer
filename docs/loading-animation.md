# A little thinking time

Longer tasks now show a little thinker reading a book, with floating thought
bubbles that change between a star, pencil and building blocks. The animation
runs in the browser and does not request extra AI work or download artwork.

You will see it while Organizer creates activity ideas, generates step pictures,
previews a generated activity week, prepares an AI summary, generates a meal
plan, reads a statement or recipe photo, or loads/exports a report. Short
connection checks and picture loading use a smaller, still illustration.

**Pause animation** makes the picture still while the task continues. Choose
**Resume animation** to start it moving again. The separate **Stop** or
**Cancel** action still stops the request where that action is available.
Pausing the decoration does not cancel generation or change your work.

If your phone or computer has **Reduce Motion** enabled, the picture is still
automatically and explains why. Choose **Play animation** to allow movement for
that loading scene. The next scene follows your system setting again.
Status messages and real progress remain available. Picture jobs
show the actual completed-image count. Tasks with an unknown completion time
show their status without an invented percentage or countdown.

The layout fits a 320-pixel phone screen. The drawing is decorative and hidden
from screen readers; task text is announced through one polite status region.
Pause and cancellation controls remain outside that region. Loading scenes are
omitted from printed plans and reports. Completion, failure, cancellation and
access changes use the existing request lifecycle, so an animation disappears
with the pending operation.

Activity ideas, step pictures and generated-week previews replace their long
settings with a dedicated waiting panel. The dialog moves to the top when work
starts, so the picture, status and Stop or Cancel action are visible without
scrolling. The settings and any existing ideas stay in memory. Stopping returns
to them; it does not save a draft or start another request.

## When the AI machine is busy

The text model and picture generator share the laptop's AI capacity. A ready
connection does not mean that capacity is free. If activity ideas receive an
explicit **AI_BUSY** rejection, Organizer keeps the waiting panel visible and
tries again automatically, for up to two minutes of waiting and at most 25
attempts. **Stop AI generation** cancels the wait immediately. If it remains busy,
the error appears in view and you can retry when the machine is free.

Only that explicit rejection is retried. Connection failures, timeouts, access
errors and uncertain failed requests are not replayed: they might already have
started work. A request that has been accepted is allowed to finish normally.
Changing access or closing the dialog stops its pending client request and wait.
This behavior does not restart the laptop, clear its work, or interrupt another
person's generation.

## Install this update

Apply the updated source ZIP using its `APPLY.sh` or `APPLY.ps1`, review the staged
changes and commit them. Bring the commit into the Pi checkout through your
normal Git workflow, then run:

```bash
bash SKAO.sh update
```

Refresh Organizer after the update. The animation appears automatically when a
supported task is running. This is a client UI change; the existing Windows
Ollama, gateway and image-worker installation can stay as it is.

The shared component is `client/src/components/LoadingScene.tsx`, with scoped CSS
beside it. Its optional `progress` input accepts actual completed/total counts;
otherwise it renders no progress bar. It has no timers, external asset URLs or
new dependencies. The existing focused update checks include its accessibility
tests and the AI browser checks include pending-state, pause, reduced-motion,
explicit playback, progress, busy-wait, failure and cancellation coverage. The
SVG uses relative transform origins for browser compatibility.
