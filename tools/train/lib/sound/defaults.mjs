// The sound library the tools use by default: the synthesised pack (generated on first use) plus the JR East pack.
// A pack that fails to load (clips not imported on this machine) is skipped and reported, not fatal.
import { SoundLibrary } from "./index.mjs";
import { ensureSynthPack } from "./synth-pack.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;

export function defaultSounds({ engine = "afplay", volume = 0.5, packs = "packs/synth,packs/jr-east", onSkip = () => {} } = {}) {
  ensureSynthPack(ROOT + "packs/synth");
  const paths = String(packs).split(",").map((p) => (p.startsWith("/") ? p : ROOT + p));
  const ok = paths.filter((p) => { try { new SoundLibrary({ packs: [p], engine: "null" }); return true; } catch (e) { onSkip(p, e); return false; } });
  return new SoundLibrary({ packs: ok, engine, volume });
}
