// Sound packs. A pack is a directory with a pack.json manifest and the audio files it names. The repo carries manifests only;
// the audio is generated (the synth pack) or imported by you (see import-sounds.py), so nothing you do not own is committed.
//
// pack.json:
// {
//   "format": "z-sounds/1", "name": "jr-east", "license": "personal use only", "source": "where the audio came from",
//   "root": "local:sounds",                       optional: where the files are: relative to this manifest, absolute, or "local:name" for
//                                                 tools/train/local/name (default: the manifest's folder)
//   "sounds": {
//     "horn.depart": { "file": "horn.wav", "gain": 1 },                         one file
//     "flange": {                                                                several variants, one chosen per play
//       "variants": [ { "file": "flange_1.wav", "weight": 3 }, { "file": "flange_2.wav", "durationMs": 1870 } ],
//       "noRepeat": true, "gainJitter": 0.2, "rateJitter": 0, "gain": 0.4 },
//     "motion.run": { "file": "run_siv.wav", "loop": true, "gain": 0.6 }
//   }
// }
// An id is "category.name" (the part before the first dot is the category) or a bare category name. "category" can be set explicitly.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { wavDurationMs } from "./wav.mjs";
import { localPath } from "../paths.mjs";

export const PACK_FORMAT = "z-sounds/1";

export function loadPack(manifestPath) {
  const file = existsSync(manifestPath) && manifestPath.endsWith(".json") ? manifestPath : resolve(manifestPath, "pack.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw.format !== PACK_FORMAT) throw new Error(`${file}: format must be "${PACK_FORMAT}" (got ${JSON.stringify(raw.format)})`);
  if (!raw.sounds || typeof raw.sounds !== "object") throw new Error(`${file}: no "sounds"`);
  const root = !raw.root ? dirname(file) : raw.root.startsWith("local:") ? localPath(raw.root.slice(6)) : resolve(dirname(file), raw.root);
  const entries = {};
  for (const [id, e] of Object.entries(raw.sounds)) {
    const list = e.variants || (e.file ? [{ file: e.file, durationMs: e.durationMs, weight: e.weight }] : null);
    if (!list || !list.length) throw new Error(`${file}: "${id}" needs "file" or "variants"`);
    const variants = list.map((v) => {
      if (!v.file) throw new Error(`${file}: a variant of "${id}" has no file`);
      const path = isAbsolute(v.file) ? v.file : resolve(root, v.file);
      const weight = v.weight ?? 1;
      if (!(weight > 0)) throw new Error(`${file}: "${id}" variant ${v.file} has a bad weight`);
      return { file: v.file, path, weight, durationMs: v.durationMs ?? null };
    });
    entries[id] = {
      id, category: e.category || id.split(".")[0], pack: raw.name || file, variants,
      gain: e.gain ?? 1, loop: !!e.loop, noRepeat: e.noRepeat ?? true,
      gainJitter: e.gainJitter ?? 0, rateJitter: e.rateJitter ?? 0, description: e.description || "",
    };
  }
  return { name: raw.name || file, license: raw.license || "", source: raw.source || "", file, root, entries };
}

/** Duration of a variant: from the manifest, else read from a WAV header, else null (unknown). */
export function variantDurationMs(v) {
  if (v.durationMs != null) return v.durationMs;
  const d = existsSync(v.path) ? wavDurationMs(v.path) : null;
  if (d != null) v.durationMs = d;
  return d;
}
