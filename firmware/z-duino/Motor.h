#ifndef MOTOR_H
#define MOTOR_H

#include <Arduino.h>

class Motor {
  public:
    Motor(int pinPwm, int pinIn1, int pinIn2);
    void forward(int speed);
    void reverse(int speed);
    void stop();

  private:
    int _pinPwm;
    int _pinIn1;
    int _pinIn2;
};

#endif
