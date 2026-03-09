#ifndef STATUS_LED_H
#define STATUS_LED_H

#include <Arduino.h>

enum LEDState {
  WIFI_CONNECTING,
  IDLE,
  ACTIVE_FORWARD,
  ACTIVE_REVERSE,
  LED_TEST
};

class StatusLED {
  public:
    StatusLED(int pinR, int pinG, int pinB);
    void setState(LEDState state);
    void setTestColor(int r, int g, int b);
    void update();

  private:
    void setColor(int r, int g, int b);
    int _pinR;
    int _pinG;
    int _pinB;
    LEDState _state;
};

#endif
