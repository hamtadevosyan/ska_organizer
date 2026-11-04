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
automatically. Status messages and real progress remain available. Picture jobs
show the actual completed-image count. Tasks with an unknown completion time
show their status without an invented percentage or countdown.

The layout fits a 320-pixel phone screen. The drawing is decorative and hidden
from screen readers; task text is announced through one polite status region.
Pause and cancellation controls remain outside that region. Loading scenes are
omitted from printed plans and reports. Completion, failure, cancellation and
access changes use the existing request lifecycle, so an animation disappears
with the pending operation.

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
progress, failure and cancellation coverage.
