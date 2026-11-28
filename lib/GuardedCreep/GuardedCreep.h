#ifndef GUARDED_CREEP_H
#define GUARDED_CREEP_H

#include <stdint.h>

// A creep the controller runs itself: creep speed, stopped on the board by beam events or a time limit. No hardware.

enum CreepEvent { CREEP_EV_BREAK = 1, CREEP_EV_RESTORE = 2 };

struct CreepRequest {
  bool valid = false; bool forward = true;
  uint8_t until[2] = {0, 0}; uint8_t nUntil = 0;
  unsigned long maxMs = 0, afterMs = 0; int id = 0;
};

enum CreepEnd { CREEP_NONE, CREEP_EVENT, CREEP_TIMEOUT, CREEP_ABORTED };
enum Parked { PARKED_NONE, PARKED_NOSE, PARKED_TAIL };

struct CreepOutput {
  const char* error = nullptr;   // start(): why it was refused
  bool motor = false; float speed = 0; bool forward = true;
  bool started = false, ended = false;
  CreepEnd result = CREEP_NONE; const char* detail = "";
};

class GuardedCreep {
 public:
  static constexpr float MAX_SPEED = 0.15f;
  static const unsigned long GRACE_MS = 1000;

  explicit GuardedCreep(float speed) : _speed(speed > MAX_SPEED ? MAX_SPEED : speed) {}
  CreepOutput start(unsigned long now, const CreepRequest& r, bool sensorPresent, bool calibrated, bool calibrating, float motorSpeed, bool motorForward);   // may start while already creeping the same way
  CreepOutput onBeam(unsigned long now, CreepEvent e);   // also clears parked when idle
  CreepOutput tick(unsigned long now);
  CreepOutput abort(const char* why);                    // no-op when idle

  bool running() const { return _running; }
  int id() const { return _req.id; }
  bool forward() const { return _req.forward; }
  Parked parked() const { return _parked; }
  void clearParked() { _parked = PARKED_NONE; }
  static const char* resultName(CreepEnd e);
  static const char* parkedName(Parked p);

 private:
  CreepOutput end(CreepEnd how, const char* detail);
  float _speed;
  bool _running = false;
  CreepRequest _req;
  unsigned long _start = 0, _doneAt = 0;
  uint8_t _seen = 0; bool _done = false;
  Parked _parked = PARKED_NONE;
};

#endif
