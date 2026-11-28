#include "GuardedCreep.h"

const char* GuardedCreep::resultName(CreepEnd e) {
  return e == CREEP_EVENT ? "event" : e == CREEP_TIMEOUT ? "timeout" : e == CREEP_ABORTED ? "aborted" : "none";
}

const char* GuardedCreep::parkedName(Parked p) {
  return p == PARKED_NOSE ? "nose" : p == PARKED_TAIL ? "tail" : nullptr;
}

CreepOutput GuardedCreep::start(unsigned long now, const CreepRequest& r, bool sensorPresent, bool calibrated, bool calibrating, float motorSpeed, bool motorForward) {
  CreepOutput o;
  if (!sensorPresent) { o.error = "no sensor connected"; return o; }
  if (!r.valid) { o.error = "bad creep arguments"; return o; }
  if (!calibrated) { o.error = "calibrate the sensor first"; return o; }
  if (calibrating) { o.error = "calibration is running"; return o; }
  if (_running) { o.error = "a creep is already running"; return o; }
  if (motorSpeed > _speed + 0.001f || (motorSpeed > 0 && motorForward != r.forward)) { o.error = "stop the train first"; return o; }
  _req = r; _running = true; _start = now; _seen = 0; _done = false; _parked = PARKED_NONE;
  o.started = true; o.motor = true; o.speed = _speed; o.forward = r.forward;
  return o;
}

CreepOutput GuardedCreep::end(CreepEnd how, const char* detail) {
  CreepOutput o;
  _running = false;
  o.ended = true; o.result = how; o.detail = detail; o.motor = true; o.speed = 0; o.forward = _req.forward;
  if (how == CREEP_EVENT && _req.afterMs == 0) {
    bool isBreak = _req.until[_req.nUntil - 1] == CREEP_EV_BREAK;
    _parked = (isBreak == _req.forward) ? PARKED_NOSE : PARKED_TAIL;   // break forward or restore reverse: nose at the beam
  }
  return o;
}

CreepOutput GuardedCreep::onBeam(unsigned long now, CreepEvent e) {
  if (!_running) { _parked = PARKED_NONE; return CreepOutput(); }   // the beam changed with nothing moving it: someone's hand
  if (_done || _req.until[_seen] != e) return CreepOutput();
  if (++_seen < _req.nUntil) return CreepOutput();
  _done = true; _doneAt = now;
  if (_req.afterMs == 0) return end(CREEP_EVENT, "");
  return CreepOutput();
}

CreepOutput GuardedCreep::tick(unsigned long now) {
  if (!_running) return CreepOutput();
  unsigned long dt = now - _start;
  if (_done) {
    if (now - _doneAt >= _req.afterMs || dt >= _req.maxMs + GRACE_MS) return end(CREEP_EVENT, "");
    return CreepOutput();
  }
  if (dt >= _req.maxMs) return end(CREEP_TIMEOUT, "");
  return CreepOutput();
}

CreepOutput GuardedCreep::abort(const char* why) {
  if (!_running) return CreepOutput();
  return end(CREEP_ABORTED, why ? why : "aborted");
}
