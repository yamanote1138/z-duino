#include "Motor.h"

Motor::Motor(int pinPwm, int pinIn1, int pinIn2)
  : _pinPwm(pinPwm), _pinIn1(pinIn1), _pinIn2(pinIn2)
{
  pinMode(_pinPwm, OUTPUT);
  pinMode(_pinIn1, OUTPUT);
  pinMode(_pinIn2, OUTPUT);
  stop();
}

void Motor::forward(int speed) {
  digitalWrite(_pinIn1, HIGH);
  digitalWrite(_pinIn2, LOW);
  analogWrite(_pinPwm, speed);
}

void Motor::reverse(int speed) {
  digitalWrite(_pinIn1, LOW);
  digitalWrite(_pinIn2, HIGH);
  analogWrite(_pinPwm, speed);
}

void Motor::stop() {
  analogWrite(_pinPwm, 0);
  digitalWrite(_pinIn1, LOW);
  digitalWrite(_pinIn2, LOW);
}
