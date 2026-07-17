#include "MotorLogic.h"

MotorDecision decideMotorState(float speed, int maxPwm, bool direction, bool invertDirection) {
  int pwmValue = (int)(speed * maxPwm);
  bool motorDirection = invertDirection ? !direction : direction;

  if (pwmValue == 0) {
    return { MOTOR_STOP, 0 };
  }
  if (motorDirection) {
    return { MOTOR_FORWARD, pwmValue };
  }
  return { MOTOR_REVERSE, pwmValue };
}
