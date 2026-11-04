# Activity image tests: SD1.5 and SDXL

This is a laptop-only test for the Quadro P3200 with 6 GB GPU memory. It installs a separate image runtime, generates synthetic activity illustrations, records timings and closes the image process. It does not yet add images to Organizer.

Both SD1.5 and SDXL have generated four-picture results on the P3200 laptop. The reported first SD1.5 image time was 28.67 seconds; no SDXL timing report has been provided. Prompt-only results showed incorrect grouping, tower construction or storage. Shorter action-first prompts improved the box picture. Reference-guided generation has now produced four pictures reported as better by the user. The review page shows one generated picture per step, with optional reference drawings in a closed section.

Keep Organizer on the Pi and the existing Windows Ollama installation running normally. No Pi command, application update, database migration, gateway change or additional firewall rule is needed for this test.

## Run from Windows PowerShell, including over SSH

For the single-file download `Setup-SKAO-ActivityImages.ps1`, save it on the laptop and run this complete line from its folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Setup-SKAO-ActivityImages.ps1 -TestGeneration
```

The standalone script contains the same readable setup, runner and pinned-download metadata as the repository. It saves its companion tools under `%LOCALAPPDATA%\SKAO-ActivityImageTools` before invoking setup. A later `-Check` verifies existing tools without rewriting them. To rebuild this file from the repository, use `python scripts/local-ai/build-image-test.py --output <destination.ps1>`.

Sign in through SSH as the same protected Windows AI account. Open the extracted test package, or your Organizer checkout after applying the patch, and run the following complete line from its root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-ai\windows\Setup-ActivityImages.ps1 -TestGeneration
```

Initial setup downloads about **6.2 GB** from the official ComfyUI, Stable Diffusion and 7-Zip release locations. Allow at least **20 GiB free disk space** for downloads, extraction and the installed checkpoint. Downloads are checked against the exact sizes and SHA-256 values saved in `scripts/local-ai/image-downloads.json`. An interrupted download is retried on the next run; a completed verified download is reused.

There is no Windows installer, account change or administrator prompt. If an existing 7-Zip command is unavailable, setup downloads a small, pinned portable extractor. Do not install the default ComfyUI CUDA 13 package on this Pascal GPU. This script selects the official CUDA 12.6 / Python 3.12 portable package.

Run the test while no one is requesting AI content through Organizer. The script checks that Ollama has no loaded model before starting. A loaded model may be busy, so the test leaves it alone and asks you to wait for its normal unload. It does not stop the Ollama task or send an unload command. This first test has no shared request lock with Organizer; avoid starting an AI request during it.

The first run generates one **512 × 512** illustration of a simple colored-block activity. Setup and model loading may take longer than subsequent images. The test prints the actual result location and timing summary. Keep the SSH session open until it finishes. Inference can use the GPU, increase fan noise and affect other work during the test.

## Test all four steps

After checking that the first picture is useful, run:

```powershell
# Single-file download:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Setup-SKAO-ActivityImages.ps1 -TestGeneration -Count 4

# Or, from the repository/extracted package:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-ai\windows\Setup-ActivityImages.ps1 -TestGeneration -Count 4
```

This generates four images one after another using the same materials and illustration style. Captions and step numbers are saved as ordinary text beside the images; the model is not asked to draw lettering. Matching materials and style is a prompt convention, not a guarantee that the model will preserve them across pictures.

Open the reported result folder to inspect the pictures. If you are working only through SSH, copy that reported folder to your regular computer with your normal `scp` client. You do not need to open an image-server port or put it through the gateway.

Keep these observations for our next step:

- The printed startup and per-image times.
- Whether each picture shows the correct objects and action.
- Whether the four pictures are consistent and useful as instructions.
- Whether ordinary laptop use remained comfortable during generation.

GPU memory readings, when `nvidia-smi` is available, describe sampled use of the whole device, including other programs. They are not an exact peak for this process. A failure or cancellation keeps a report marked incomplete and any finished pictures.

## Check or install without generating

```powershell
# Read-only: verify an existing image installation, without downloading or starting it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-ai\windows\Setup-ActivityImages.ps1 -Check

# Install the separate runtime and model without running an image test.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-ai\windows\Setup-ActivityImages.ps1
```

The installation is under `%LOCALAPPDATA%\SKAO-ActivityImages` for the AI account. Setup reuses a matching recorded installation and refuses to overwrite different or unrecognized content. Do not run ComfyUI's update scripts in that managed directory. They would change the pinned runtime and could remove legacy GPU compatibility. Use a separate directory for unrelated ComfyUI experiments.

## Compare SDXL Base after SD1.5 is installed

Replace the downloaded single-file setup script with the current version. From the AI account's SSH PowerShell session, run its actual file path:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityImages.ps1" -CompareSDXL -TestGeneration
```

This explicitly selects SDXL Base 1.0. It requires the existing verified SD1.5 installation and reuses its ComfyUI runtime, Python, PyTorch, legacy CUDA build and startup workaround. It downloads only the pinned SDXL checkpoint, about **6.94 GB**. The existing SD1.5 installation receipt and model remain authoritative and usable with the normal command. Allow space for both the download cache and the installed copy.

The first comparison generates one **1024 x 1024** image at SDXL's recommended native resolution. Its checkpoint includes a VAE; the test uses the existing CPU VAE option and does not download a refiner. Prompts, captions, seed, sampler, step count and guidance setting match the SD1.5 test. SDXL uses its own dual text encoders and image-size conditioning. This compares the two models at their intended resolutions, rather than claiming equal-resolution speed.

Keep the AI window quiet and run one image test at a time. SDXL has produced pictures on the laptop, but its timing, memory report and effect on daily use have not been reviewed. An out-of-memory error or time limit is reported as a failed test; the tool does not silently substitute another model or a smaller picture.

If the one-image test completes and the picture is useful, run all four scenes:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityImages.ps1" -CompareSDXL -TestGeneration -Count 4
```

The printed result folder identifies the SDXL run. Copy that whole folder back over SSH to review its `review.html`, pictures and timing report. Compare whether step 2 shows sorted groups, step 3 shows the stated three-color tower, and step 4 puts every block inside the box. More attractive pictures are not sufficient if they show the wrong actions.

For an installed comparison checkpoint, `-CompareSDXL -Check` is read-only. Running `-CompareSDXL` without `-TestGeneration` prepares only the comparison checkpoint. Neither command converts existing SD1.5 results or changes the saved benchmark prompts. SDXL may still fail to preserve counts, colors or relationships across pictures; review the actual output before deciding whether it is suitable for the app.

## Try shorter, action-first prompts

Replace the downloaded setup file with the current version in the AI account's `Downloads` folder. In that account's SSH PowerShell session, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityImages.ps1" -CompareSDXL -SimplePrompts -TestGeneration -Count 4
```

This trial puts the required objects and arrangement first, followed by a short illustration style. It removes the long shared style prefix and avoids naming unwanted objects in the positive prompt. The original negative prompt, captions, seed, sampling settings, native resolution and selected model stay the same. It is a prompt comparison, not a guarantee of correct counts or actions.

With the already verified SDXL installation, no runtime or model download is needed. A new companion-tool folder is selected for the updated scripts; previous results, model files and installation receipts are preserved. The gallery and report identify the simple prompt trial. The report also records the fixed synthetic prompt text requested for each step, so we can check the intended instructions.

Review all four pictures against their captions, especially the sorted pairs, three-block tower and all six blocks inside a box. Copy the whole printed result folder to the computer where you view pictures, as before. Keep SSH connected and Organizer AI requests quiet until generation finishes. The reviewed laptop run showed partial improvement in the box picture, but the sorting and tower pictures still failed. The next trial below adds reference guidance.

`-SimplePrompts` requires `-TestGeneration` and cannot be combined with `-Check`. To try the same prompt revision with SD1.5, omit `-CompareSDXL`. To reproduce the original prompt comparison, omit `-SimplePrompts`.

## Guide SDXL with prepared reference layouts

Replace the downloaded setup file with the current version in the protected AI account's `Downloads` folder. In that account's SSH PowerShell session, first generate one guided picture:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityImages.ps1" -CompareSDXL -GuidedLayout -TestGeneration
```

The already installed runtime and SDXL checkpoint are reused. The first guided run downloads one additional, verified **395.7 MB** Canny Control-LoRA rank128 checkpoint from Stability AI. Allow about **2 GiB** additional free disk space for its download cache, installed copy and setup buffer. Guided generation has produced pictures on the P3200, but timing and GPU-memory reports have not been reviewed. Its smaller download size does not establish its runtime GPU-memory use.

The tool creates a fixed color drawing for each requested step, then uses its colors and edge outlines to guide generation. No drawing or image upload is required from you. These synthetic layouts are made by code for this specific block activity. They provide an intended arrangement; the resulting AI picture must still be checked for correct colors, counts and actions.

This is an image-to-image plus Canny guidance trial. It uses the shorter positive prompts, the existing negative prompt, SDXL at 1024 x 1024, batch size one, the same seed, Euler sampling, 20 steps and guidance scale 7. The trial starts from the reference image with denoise 0.55 and Control-LoRA strength 0.8. These values are experimental starting settings. The report records the selected mode, reference-image filenames and hashes, and generation settings. This is a different generation method from the earlier prompt-only comparison.

If the one-picture run completes and the output follows its reference, generate all four steps:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityImages.ps1" -CompareSDXL -GuidedLayout -TestGeneration -Count 4
```

The main review view shows each generated step once. Select **Show reference drawings** to expand the input layouts for comparison. Reference layouts are input drawings, not AI results or evidence that the model followed them. Copy the whole printed result folder, including its `input` subfolder, when viewing it on another computer. Keep SSH connected and avoid Organizer AI requests while this attended test runs. Compare the tower, separated color pairs and containment inside the box before deciding whether the output is useful.

`-GuidedLayout` requires `-CompareSDXL`. It selects the shorter prompts automatically. For an existing installation, `-CompareSDXL -GuidedLayout -Check` is read-only and verifies the extra checkpoint too. Omitting `-TestGeneration` installs the guidance checkpoint without starting inference. Omitting `-GuidedLayout` preserves the earlier SDXL and simple-prompt commands.

The new helper uses Pillow already included in the portable runtime. Canny, ControlNet and image loading use the pinned runtime's built-in nodes. Missing runtime capabilities produce a clear failed test; setup does not upgrade packages or install custom nodes. Previous model files, installation receipts, Ollama, the private gateway and Pi settings are preserved.

## Update an existing review page without generating again

Replace the downloaded setup script with the current version on the AI laptop. In its SSH PowerShell session, pass the existing results folder that contains `report.json` and the pictures. For example, for the copied folder shown in the user's latest review:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\Setup-SKAO-ActivityImages.ps1" -RefreshReview "$HOME\Downloads\SKAO-image-results\sdxl-guided-pyrwo553"
```

Use the actual folder path if yours differs. An original result under `%LOCALAPPDATA%\SKAO-ActivityImages\results` can be refreshed the same way. This uses the already installed portable Python and the saved report. It does not start ComfyUI or Ollama, load models, download weights or regenerate any image.

The command updates only `review.html` and keeps its first previous version as `review-before-update.html`. Reports and picture bytes stay unchanged. The main view shows one generated picture per completed step; references are available in the closed **Show reference drawings** section. Repeated refresh preserves the first backup. If viewing a copied folder on another computer, copy the updated `review.html` into that copy and reload the browser page.

`-RefreshReview` is a separate mode. Supply only that path; do not combine it with generation, model-selection, check or count options. Existing reports are validated before their page is updated. The AI laptop still needs its existing portable Python, but it does not need a running image service.

The benchmark binds its own image server to `127.0.0.1` and stops only the process it started, including after a handled error or Ctrl+C. It does not create a startup task. Rebooting Windows does not start the image test.

The launcher loads the installed PyAV package before starting ComfyUI. On the P3200 laptop, standalone PyAV and both PyAV/PyTorch import orders passed, while full ComfyUI startup stalled in PyAV's native codec import. Loading it first allowed SD1.5 generation to complete in the reported laptop run. It does not replace either package or change CUDA settings. The optional SDXL test reuses this startup behavior.

During startup, the launcher records Python stack traces automatically if initialization stalls. That tracing stops when the server is ready. A failed test prints a bounded tail of `runtime.log` along with the report path, so the SSH output contains the next diagnostic without a separate probe.

## Privacy and limits

The test uses fixed synthetic prompts about colored blocks, without child names, photos, reports or saved Organizer records. The generated images remain on the laptop. Setup downloads software and weights over the internet; generation uses the local checkpoint. Custom nodes and paid/API nodes are disabled. ComfyUI's offline option is not an operating-system network firewall.

This package has automated installer, renderer and API-client checks. SD1.5, SDXL, the simple-prompt trial, reference-guided generation and the PyAV startup workaround have produced laptop results reported by the user. Prompt-only pictures failed their instructional quality check; guided results were reported as better. Guided memory use, timing and accuracy across other activities still need evaluation. Image generation, saving into activities and sharing images with classroom viewers are not implemented by this package. Those application changes follow the hardware and visual-quality tests.

## Download provenance

- [ComfyUI v0.43.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.43.0) and its [official asset metadata](https://api.github.com/repos/Comfy-Org/ComfyUI/releases/tags/v0.43.0). The release is marked immutable; the legacy archive's SHA-256 and byte count were obtained from its asset metadata.
- [Official ComfyUI portable instructions](https://github.com/Comfy-Org/ComfyUI/blob/v0.43.0/README.md) and [basic API example](https://github.com/Comfy-Org/ComfyUI/blob/v0.43.0/script_examples/basic_api_example.py).
- [SD1.5 checkpoint at its pinned revision](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/blob/f03de327dd89b501a01da37fc5240cf4fdba85a1/v1-5-pruned-emaonly.safetensors) and [model card and license](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5).
- [Official 7-Zip 26.05 release](https://github.com/ip7z/7zip/releases/tag/26.05) and [license](https://www.7-zip.org/license.txt).
- [Official SDXL Base checkpoint at the pinned revision](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors), [model card and license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) and [ComfyUI SDXL example guidance](https://comfyanonymous.github.io/ComfyUI_examples/sdxl/).
- [Official Canny Control-LoRA rank128 checkpoint at the pinned revision](https://huggingface.co/stabilityai/control-lora/blob/75590eb0e7868d3d0f1581b5126d487b33c7fdb4/control-LoRAs-rank128/control-lora-canny-rank128.safetensors), its [model card](https://huggingface.co/stabilityai/control-lora) and [ComfyUI ControlNet examples](https://comfyanonymous.github.io/ComfyUI_examples/controlnet/). Stability AI identifies rank128 as experimental. The exact checkpoint hash and byte count were verified through the official repository metadata; it is not bundled in the source ZIP.
