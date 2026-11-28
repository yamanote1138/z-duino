// Reading and writing shows, layouts and the loco profile. A show is plain JSON ("z-show/1"), so it can be shared as a file.
import { readFileSync, writeFileSync } from "node:fs";
import { localPath, localFile } from "../paths.mjs";

export { SHOW_FORMAT } from "./schema.mjs";
export const LAYOUT_FORMAT = "z-layout/1";

const readJson = (file, what) => {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { throw new Error(`cannot read ${what} ${file}: ${e.code === "ENOENT" ? "no such file" : e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${what} ${file} is not valid JSON: ${e.message}`); }
};
export const parseShow = (text) => JSON.parse(text);
export const loadShow = (file) => readJson(file, "show");
/** Export: stable key order, two-space indent, trailing newline, so shows diff cleanly. */
export const stringifyShow = (show) => JSON.stringify(show, null, 2) + "\n";
export const saveShow = (show, file) => writeFileSync(file, stringifyShow(show));

export const loadLayout = (file = localPath("layout.json")) => readJson(file, "layout");
export function validateLayout(layout) {
  const errors = [];
  if (!layout || layout.format !== LAYOUT_FORMAT) errors.push(`layout: format must be "${LAYOUT_FORMAT}"`);
  else {
    if (layout.loopIn != null && !(layout.loopIn > 0)) errors.push("layout.loopIn must be a positive number of inches");
    for (const [name, z] of Object.entries(layout.zones || {})) {
      if (!(typeof z.fromIn === "number" && typeof z.toIn === "number" && z.toIn > z.fromIn)) errors.push(`layout.zones.${name}: needs fromIn < toIn (inches of nose travel past the beam)`);
      if (layout.loopIn && z.toIn > layout.loopIn) errors.push(`layout.zones.${name}: toIn ${z.toIn} is beyond the loop length ${layout.loopIn}`);
    }
  }
  return errors;
}

/** The loco: length and speed model, from local/loco_profile.json. */
export const loadLoco = (file = localPath("loco_profile.json")) => readJson(file, "loco profile");
export { localFile };
