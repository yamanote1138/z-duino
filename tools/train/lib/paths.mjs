// Where your own files live. Everything specific to your layout, loco and room is kept in one git-ignored folder, so a
// clone starts clean and pulling never touches your calibration.
//
//   <tools/train>/local/            (override with the TRAIN_LOCAL environment variable)
//     sensor_levels.json            written by calibrate.mjs
//     loco_profile.json             written by learn-loco.mjs
//     results/                      light_test_results.csv
//     traces/                       raw sensor traces (*.csv) and run logs
//     shows/  layout.json           shows and layout you author
//     sounds/ packs/                your own sound files and sound packs
//
// local/README.md describes the folder; nothing else in it is committed.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_DIR = resolve(process.env.TRAIN_LOCAL || fileURLToPath(new URL("../local/", import.meta.url)));

/** Absolute path of a file or folder inside local/ (nothing is created). */
export const localPath = (...parts) => join(LOCAL_DIR, ...parts);

/** Same, and makes sure the folder it sits in exists: use it for a file you are about to write. */
export function localFile(...parts) {
  const p = localPath(...parts);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}
