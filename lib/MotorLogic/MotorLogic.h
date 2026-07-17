#ifndef MOTOR_LOGIC_H
#define MOTOR_LOGIC_H

enum MotorAction {
  MOTOR_STOP,
  MOTOR_FORWARD,
  MOTOR_REVERSE
};

struct MotorDecision {
  MotorAction action;
  int pwm;
};

// Pure decision logic: given the current speed/direction/invert state,
// decide what the motor driver should do. No hardware I/O.
MotorDecision decideMotorState(float speed, int maxPwm, bool direction, bool invertDirection);

#endif
