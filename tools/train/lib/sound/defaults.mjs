// The sound library the tools use by default: the synthesised pack (generated on first use) plus the JR East pack.
// Which packs: the sound.packs setting (lib/config). A pack that fails to load (clips not imported on this machine) is skipped and reported, not fatal.
import { SoundLibrary } from "./index.mjs";
import { ensureSynthPack } from "./synth-pack.mjs";
import { localPath } from "../paths.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;

/** A pack as written in the settings: absolute as is, "local:name" under local/, otherwise relative to tools/train/. */
export const packPath = (p) => (p.startsWith("/") ? p : p.startsWith("local:") ? localPath(p.slice(6)) : ROOT + p);

export function defaultSounds({ engine = "afplay", volume = 0.5, packs = ["packs/synth", "packs/jr-east"], onSkip = () => {} } = {}) {
  ensureSynthPack(ROOT + "packs/synth");
  const paths = (Array.isArray(packs) ? packs : String(packs).split(",")).map(packPath);
  const ok = paths.filter((p) => { try { new SoundLibrary({ packs: [p], engine: "null" }); return true; } catch (e) { onSkip(p, e); return false; } });
  return new SoundLibrary({ packs: ok, engine, volume });
}
