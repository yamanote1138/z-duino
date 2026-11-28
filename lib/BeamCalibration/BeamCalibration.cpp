#include "BeamCalibration.h"
#include <string.h>
#include <stdio.h>

const char* BeamCalibration::phaseName() const {
  switch (_phase) {
    case CAL_IDLE: return "idle";
    case CAL_MEASURE_A: return "measuring";
    case CAL_CREEP_FWD: case CAL_PAUSE: case CAL_CREEP_REV: case CAL_OVERRUN: return "creeping";
    case CAL_SETTLE: case CAL_MEASURE_B: case CAL_DERIVE: return "measuring_second";
    case CAL_DONE: return "done";
    default: return "failed";
  }
}

CalOutput BeamCalibration::start(unsigned long now, bool sensorPresent, bool motorRunning) {
  CalOutput o;
  if (running()) { o.error = "already calibrating"; return o; }
  if (!sensorPresent) { o.error = "no sensor connected"; return o; }
  if (motorRunning) { o.error = "stop the train first"; return o; }
  _detail[0] = 0;
  enter(CAL_MEASURE_A, now, o);
  o.sendMeasure = true;
  return o;
}

CalOutput BeamCalibration::fail(const char* why, bool stopMotor) {
  CalOutput o;
  snprintf(_detail, sizeof(_detail), "%s", why ? why : "failed");
  _phase = CAL_FAILED; o.phaseChanged = true; o.sendWatchOff = true;
  if (stopMotor) { o.motor = true; o.speed = 0; }
  return o;
}

CalOutput BeamCalibration::abort(const char* why) {
  if (!running()) return CalOutput();
  return fail(why, true);
}

CalOutput BeamCalibration::tick(unsigned long now) {
  CalOutput o;
  unsigned long dt = now - _since;
  switch (_phase) {
    case CAL_MEASURE_A: case CAL_MEASURE_B: case CAL_DERIVE:
      if (dt >= ANSWER_MS) return fail("the sensor stopped answering", true);
      break;
    case CAL_CREEP_FWD:
      if (dt >= FORWARD_MS) { enter(CAL_PAUSE, now, o); o.motor = true; o.speed = 0; o.forward = true; }
      break;
    case CAL_PAUSE:
      if (dt >= PAUSE_MS) {
        enter(CAL_CREEP_REV, now, o); o.motor = true; o.speed = _speed; o.forward = false;
        o.sendWatch = true; o.watchFrom = _a.median;   // re-arm: a change near the end of the forward creep may have used it up
      }
      break;
    case CAL_CREEP_REV:
      if (dt >= REVERSE_MS) return fail("the beam never changed: is the emitter on, is the loco on the track?", true);
      break;
    case CAL_OVERRUN:
      if (dt >= OVERRUN_MS) { enter(CAL_SETTLE, now, o); o.motor = true; o.speed = 0; o.sendWatchOff = true; }
      break;
    case CAL_SETTLE:
      if (dt >= SETTLE_MS) { enter(CAL_MEASURE_B, now, o); o.sendMeasure = true; }
      break;
    default: break;
  }
  return o;
}

CalOutput BeamCalibration::onMeasured(unsigned long now, Stats s) {
  CalOutput o;
  if (_phase == CAL_MEASURE_A) {
    _a = s;
    enter(CAL_CREEP_FWD, now, o);
    o.motor = true; o.speed = _speed; o.forward = true;
    o.sendWatch = true; o.watchFrom = s.median;
  } else if (_phase == CAL_MEASURE_B) {
    _b = s;
    enter(CAL_DERIVE, now, o);
    o.sendLevels = true;
  }
  return o;
}

CalOutput BeamCalibration::onChanged(unsigned long now) {
  CalOutput o;
  if (_phase == CAL_CREEP_FWD || _phase == CAL_CREEP_REV) enter(CAL_OVERRUN, now, o);   // carry on a moment so the loco is well past the edge
  else if (_phase == CAL_PAUSE) { enter(CAL_SETTLE, now, o); o.sendWatchOff = true; }   // already stopped in the changed state
  return o;
}

CalOutput BeamCalibration::onResult(bool ok, const char* error) {
  if (_phase != CAL_DERIVE) return CalOutput();
  if (!ok) return fail(error, false);
  CalOutput o; _phase = CAL_DONE; o.phaseChanged = true;
  snprintf(_detail, sizeof(_detail), "clear %d, blocked %d", _a.median > _b.median ? _a.median : _b.median, _a.median > _b.median ? _b.median : _a.median);
  return o;
}
