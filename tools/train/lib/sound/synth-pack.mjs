// The built-in "synth" pack: generated sounds, so the library works with no downloads. They are impressions, not recordings.
// ensureSynthPack(dir) writes any missing WAV next to packs/synth/pack.json.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as synth from "../synth.mjs";

export const SYNTH_FILES = {
  "hum.wav": () => synth.blowerHum(30), "air.wav": () => synth.airRelease(), "chime.wav": () => synth.chime(), "bell.wav": () => synth.crossingBell(),
  "horn_air.wav": () => synth.hornAir(), "horn_electric.wav": () => synth.hornElectric(), "horn_low.wav": () => synth.hornLow(),
  "whine.wav": () => synth.inverterLoop(800, 30),
};
export function ensureSynthPack(dir) {
  mkdirSync(dir, { recursive: true });
  let made = 0;
  for (const [name, make] of Object.entries(SYNTH_FILES)) { const p = join(dir, name); if (!existsSync(p)) { synth.writeWav(p, make()); made++; } }
  return made;
}
