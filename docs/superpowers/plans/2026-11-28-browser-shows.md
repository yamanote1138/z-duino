# Browser shows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run z-show/1 shows (a JR lap with sound) in the throttle app, with a Measure loco routine.
**Architecture:** The Mac kit's show engine imported by the app; thin adapters for throttle, beam and Web Audio; a pure measurement module.
**Tech Stack:** Vue 3, Vitest, Web Audio, PlatformIO/Unity, Node test runner (tools/train).
**Spec:** docs/superpowers/specs/2026-11-28-browser-shows-design.md

## Global Constraints
- One-line comments and commits, American English. Commit and push to feature/train-beam-sensor after each task.
- Creep speed 0.15 (firmware CAL_SPEED), loop 134 in, profile key `z-duino.loco` in localStorage.
- Measure speeds 0.45, 0.35 (laps), 0.25, 0.15 (passes).

## Review Focus
- Stop mid-show (during a ramp, a wait, a creep) stops the loco and the sounds.
- The socket dropping mid-show ends it.
- A creep requested while moving above creep speed or in the other direction is refused.
- The JR lap with no profile or missing sound files refuses to start, with a reason.
- Measure loco interrupted by Stop leaves nothing half-saved.

### Task 1: Engine runs in the browser
- tools/train: `SHOW_FORMAT` moves into schema.mjs (io.mjs re-exports); `CREEP_MAX` and the Mac controller's `creepMax` become 0.15; runtime passes `event: s.until` to `guardedMove`. Mac tests stay green.
- frontend test: importing runtime.mjs and validating full-lap.json works under Vitest.

### Task 2: Firmware
- `GuardedCreep::start(now, r, sensorPresent, calibrated, calibrating, float speed, bool forward)`: refuse "stop the train first" only when speed > creep speed or (speed > 0 and forward differs). Tests for both. Serve `.m4a` as `audio/mp4`, `.json` as `application/json`.

### Task 3: Sounds
- `frontend/scripts/import-sounds.sh` writes `public/sounds/jr/*.m4a` and `pack.json`; `.gitignore` covers the audio.

### Task 4: Show host
- `src/composables/showHost.ts`: controller, sensor and sound adapters; `runJrLap()` in the controller composable with `showRun` progress; Stop aborts it. Tests with fakes.

### Task 5: Measure loco
- `src/composables/measureLoco.ts` (pure, tests), localStorage profile, button and progress in the beam panel.

### Task 6: JR lap show and button
- `src/shows/jr-lap.json`, validated in a test against the pack and an example profile; JR lap button.

### Task 7: Docs, flash, try
