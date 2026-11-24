// Running a show the other way. Shows are written once, in the layout's own orientation: the nose leads, the loco leaves the
// mark in the direction the zones were measured in, and `start: "blocked"` means the nose is on the mark. orientShow() turns
// such a show into its mirror image for a reverse run: the tail leads, the loco leaves the other way, the tail is on the mark.
//
//   const reversed = orientShow(show, "reverse", { layout });      // "forward" returns the show itself
//
// What changes (everything else, sounds and lights and settings included, is left alone):
//   - `direction` and `creep` steps run the other way round (these are physical travel directions: the sensor's nose/tail
//     labels and the position estimate follow them), and a wait for the "nose" edge becomes one for the "tail" edge
//   - a run of consecutive `fill` steps that wait for a zone is put in the order the loco meets the zones (the bends come in
//     the opposite order when going the other way); no other step changes place
//   - a show that starts on the mark gets a seating step first: forward until the tail clears the beam, then back until the
//     tail breaks it (it works from either mark and moves a few inches at creep speed, stopped by the beam each time)
// The runtime does the rest: in a reverse run a zone is met one loco length later (the tail leads into each bend), and
// `wait-approach` measures from the end that leads.

export const DIRECTIONS = ["forward", "reverse"];
const CREEP = 0.1;                       // the seating moves are at the top creep speed
const SWAP = { nose: "tail", tail: "nose" };

export function checkDirection(d) {
  if (!DIRECTIONS.includes(d)) throw new Error(`direction must be ${DIRECTIONS.join(" or ")}, not ${JSON.stringify(d)}`);
  return d;
}

export const seatingSteps = () => [
  { do: "log", message: "seating the tail on the mark: forward until the tail clears the beam, then back until it breaks it" },
  { do: "direction", forward: true },
  { do: "creep", forward: true, speed: CREEP, until: "restore", maxMs: 8000 },
  { do: "direction", forward: false },
  { do: "creep", forward: false, speed: CREEP, until: "break", maxMs: 8000 },
];

export function orientShow(show, direction = "forward", { layout = null } = {}) {
  if (checkDirection(direction) === "forward") return show;
  const out = structuredClone(show);
  const toIn = (s) => layout?.zones?.[s.zone]?.toIn;
  const waitsForZone = (s) => s && s.do === "fill" && typeof s.zone === "string" && s.wait !== false && Number.isFinite(toIn(s));

  const mirror = (steps) => {
    const list = steps.map((s) => {
      if (!s || typeof s !== "object") return s;
      if (s.do === "direction" && typeof s.forward === "boolean") s.forward = !s.forward;
      if (s.do === "creep" && typeof s.forward === "boolean") { s.forward = !s.forward; if (SWAP[s.until]) s.until = SWAP[s.until]; }
      if (s.do === "wait-for" && SWAP[s.event]) s.event = SWAP[s.event];
      if (s.do === "repeat" && Array.isArray(s.steps)) s.steps = mirror(s.steps);
      if (s.do === "parallel" && Array.isArray(s.branches)) s.branches = s.branches.map((b) => (Array.isArray(b) ? mirror(b) : b));
      return s;
    });
    // runs of zone fills, in the order the loco meets them going this way (the far end of a zone first, since it is entered from there)
    for (let i = 0; i < list.length;) {
      if (!waitsForZone(list[i])) { i++; continue; }
      let j = i; while (j < list.length && waitsForZone(list[j])) j++;
      const run = list.slice(i, j).map((s, k) => ({ s, k })).sort((a, b) => toIn(b.s) - toIn(a.s) || a.k - b.k).map((x) => x.s);
      list.splice(i, j - i, ...run);
      i = j;
    }
    return list;
  };

  out.steps = mirror(out.steps || []);
  if (out.start === "blocked") out.steps = [...seatingSteps(), ...out.steps];
  out.name = `${show.name || "show"} (reverse)`;
  return out;
}
