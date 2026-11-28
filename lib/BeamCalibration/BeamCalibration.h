#ifndef BEAM_CALIBRATION_H
#define BEAM_CALIBRATION_H

#include <BeamDetector.h>

// What the sketch should do after a calibration step: set the motor, and which messages to send the sensor.
struct CalOutput {
  const char* error = nullptr;   // start(): why it was refused
  bool motor = false;            // apply speed/forward
  float speed = 0; bool forward = true;
  bool sendMeasure = false, sendWatch = false, sendWatchOff = false, sendLevels = false;
  int watchFrom = 0;
  bool phaseChanged = false;
};

enum CalPhase { CAL_IDLE, CAL_MEASURE_A, CAL_CREEP_FWD, CAL_PAUSE, CAL_CREEP_REV, CAL_SETTLE, CAL_MEASURE_B, CAL_DERIVE, CAL_DONE, CAL_FAILED };

// The controller's side of one-button calibration: measure, creep until the beam changes, measure again. No hardware.
class BeamCalibration {
 public:
  static constexpr float MAX_SPEED = 0.15f;
  static const unsigned long FORWARD_MS = 10000, PAUSE_MS = 500, REVERSE_MS = 20000, SETTLE_MS = 500, ANSWER_MS = 6000;

  explicit BeamCalibration(float calSpeed) : _speed(calSpeed > MAX_SPEED ? MAX_SPEED : calSpeed) {}
  CalOutput start(unsigned long now, bool sensorPresent, bool motorRunning);
  CalOutput tick(unsigned long now);
  CalOutput onMeasured(unsigned long now, Stats s);
  CalOutput onChanged(unsigned long now);
  CalOutput onResult(bool ok, const char* error);
  CalOutput abort(const char* why);

  CalPhase phase() const { return _phase; }
  bool running() const { return _phase != CAL_IDLE && _phase != CAL_DONE && _phase != CAL_FAILED; }
  bool moving() const { return _phase == CAL_CREEP_FWD || _phase == CAL_CREEP_REV; }
  const char* phaseName() const;
  const char* detail() const { return _detail; }
  Stats a() const { return _a; }
  Stats b() const { return _b; }

 private:
  void enter(CalPhase p, unsigned long now, CalOutput& o) { _phase = p; _since = now; o.phaseChanged = true; }
  CalOutput fail(const char* why, bool stopMotor);
  float _speed;
  CalPhase _phase = CAL_IDLE;
  unsigned long _since = 0;
  Stats _a = {}, _b = {};
  char _detail[96] = "";
};

#endif
