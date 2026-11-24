// What calibration learns about which way "forward" is: the pure parts of `node orient.mjs`.
//
// "Forward" means the loco's front (the nose) leads, and it is the way your layout and shows are written. The motor polarity
// decides which way the controller's "forward" really moves the loco: swap the rails, or the motor leads, and it flips.
// `controller.invert` is the flag that turns it back, so calibration is finding the right value for it; it is saved in
// local/orientation.json and sent whenever a tool connects (lib/config). Which way that is on the table (right or left, as you
// face the layout) is only a label, for people.

import { ORIENTATION_FORMAT } from "../config/index.mjs";

/** The invert value to keep: the one in use if the nose led, else the other one (and the move has to be checked again). */
export function decideInvert({ invert, noseLed }) {
  return { invert: noseLed ? !!invert : !invert, flipped: !noseLed };
}

/** The file orient.mjs writes. `forwardMoves` is "right" or "left" as the person faces the layout. */
export function orientationRecord({ invert, forwardMoves, now = new Date() }) {
  if (forwardMoves !== "right" && forwardMoves !== "left") throw new Error('forwardMoves must be "right" or "left"');
  return {
    format: ORIENTATION_FORMAT, invert: !!invert, forwardMoves, calibrated: now.toISOString().slice(0, 10),
    note: "written by orient.mjs: with this invert, 'forward' makes the nose lead and the loco moves " + forwardMoves + " as you face the layout",
  };
}
