#ifndef STATUS_LED_H
#define STATUS_LED_H

#include <Arduino.h>

// The RGB status LED is optional hardware. Build with -D HAS_STATUS_LED=0 (in secrets.ini) if you did not fit one:
// StatusLED then does nothing, touches no pins, and the controller reports features.led = false so the web app and
// the Mac tools leave their LED controls out. The default is 1, so existing builds are unchanged.
#ifndef HAS_STATUS_LED
#define HAS_STATUS_LED 1
#endif

enum LEDState {
  WIFI_CONNECTING,
  IDLE,
  ACTIVE_FORWARD,
  ACTIVE_REVERSE,
  LED_TEST,
  EMERGENCY_STOP_BLINK
};

#if HAS_STATUS_LED

class StatusLED {
  public:
    StatusLED(int pinR, int pinG, int pinB);
    void setState(LEDState state);
    void setTestColor(int r, int g, int b);
    void blinkEmergencyStop();
    void update();

  private:
    void setColor(int r, int g, int b);
    int _pinR;
    int _pinG;
    int _pinB;
    LEDState _state;
    LEDState _previousState;
    int _blinkCount;
    unsigned long _blinkStartTime;
    int _testR;
    int _testG;
    int _testB;
};

#else  // no LED fitted: the same interface, so the sketch needs no #ifs at its call sites

class StatusLED {
  public:
    StatusLED() {}
    void setState(LEDState) {}
    void setTestColor(int, int, int) {}
    void blinkEmergencyStop() {}
    void update() {}
};

#endif  // HAS_STATUS_LED

#endif
