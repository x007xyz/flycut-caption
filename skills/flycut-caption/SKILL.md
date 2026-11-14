---
name: flycut-caption
description: Operate a running FlyCut Caption Host via MCP (or flycut CLI) to create projects from local media, run ASR transcription, generate review-only edit suggestions, and export subtitled video or subtitle files while keeping destructive approvals in the FlyCut UI.
---

# FlyCut Caption Skill

Use this skill when the user wants an AI agent to transcribe a video/audio file, inspect or clean up spoken-word filler/silence cuts as reviewable suggestions, or export subtitled video/subtitles through FlyCut Caption.

## Prerequisites

1. Verify connection to a running FlyCut Host by calling `flycut_host_status`.
2. If it returns `NO_HOST_CONNECTION`, instruct the user to start FlyCut Caption Desktop or run `pnpm host:dev`, or configure `FLYCUT_HOST_URL` / `FLYCUT_HOST_TOKEN` / `FLYCUT_HOST_HOME`.
3. Never read or print Host Bearer tokens or AI API keys into responses.

## Standard Workflow

1. **Inspect models**: Call `flycut_list_models` with `role: "asr"` to find a `ready` model (e.g. `sherpa-onnx`). If a model has `status: "download"`, ask or call `flycut_prepare_model`.
2. **Create project**: Call `flycut_create_project` with `name`, local `filePath`, and a stable `operationId` (UUID) so retries do not duplicate the project.
3. **Transcribe**: Call `flycut_transcribe` with `projectId`, `providerId`, `modelId`, `language`, and `operationId`.
   - With `wait: false` (default), the call returns `completed: false` and a `jobId`. Poll with `flycut_get_job` or pass `wait: true` when the client supports progress notifications.
   - Treat a task as finished only when Host reports `status: "complete"` (`completed: true`).
4. **Generate review-only suggestions** (optional): Call `flycut_suggest_edits` (`kind`: `fillers`, `silence`, `semantic`, or `all`).
   - Suggestions are stored in Host `pending-suggestions.json` and **never** modify formal subtitles, EDL, or exports until the user reviews and applies them in the FlyCut UI.
   - Share the returned `clientEntry` route (e.g. `#/projects/<projectId>/videos/<videoId>`) so the user can review before/after audio and confirm in the editor.
5. **Export new files**: Call `flycut_export` with `projectId`, `format` (`mp4`, `webm`, `srt`, `vtt`, `json`, `ass`), `subtitleProcessing` (`none` / `soft` / `hard`), and a new `outPath` (or call `flycut_save_export` after completion).

## Safety & Confirmation Rules

- **No self-approval**: You cannot approve deletions or file overwrites via MCP.
- If `flycut_export` or `flycut_save_export` returns `CONFIRMATION_REQUIRED` with a `confirmationId`, or when calling `flycut_request_delete_project` / `flycut_request_remove_video`, stop and tell the user the exact `confirmationId` and ask them to approve or reject it in the FlyCut UI confirmation center.
- Do not pass fabricated or extra approval flags (`yes`, `approve`, `actor`); strict schemas reject them.
- If waiting on a job is cancelled locally (`stoppedWaiting: true`), report accurately that `hostTaskCancelled` is `false` and provide the `jobId` for `flycut_get_job` or explicit `flycut_cancel_job`.
