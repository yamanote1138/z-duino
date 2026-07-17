#include "StatusLED.h"
#include <LedTiming.h>

StatusLED::StatusLED(int pinR, int pinG, int pinB)
  : _pinR(pinR), _pinG(pinG), _pinB(pinB), _state(WIFI_CONNECTING),
    _previousState(IDLE), _blinkCount(0), _blinkStartTime(0),
    _testR(0), _testG(0), _testB(0)
{
  pinMode(_pinR, OUTPUT);
  pinMode(_pinG, OUTPUT);
  pinMode(_pinB, OUTPUT);
  // Common cathode: 0 = fully off
  analogWrite(_pinR, 0);
  analogWrite(_pinG, 0);
  analogWrite(_pinB, 0);
}

void StatusLED::setColor(int r, int g, int b) {
  // Common cathode: value maps directly to PWM duty cycle
  // 3.3V GPIO with ~3.0V Vf on green/blue = minimal headroom, no cap needed
  analogWrite(_pinR, r);
  analogWrite(_pinG, g);
  analogWrite(_pinB, b);
}

void StatusLED::setState(LEDState state) {
  _state = state;
  switch (_state) {
    case WIFI_CONNECTING:
      // Handled in update()
      break;
    case IDLE:
      setColor(0, 0, 1000);   // Blue
      break;
    case ACTIVE_FORWARD:
      setColor(0, 1000, 0);   // Green
      break;
    case ACTIVE_REVERSE:
      setColor(1000, 0, 0);   // Red
      break;
    case LED_TEST:
      setColor(_testR, _testG, _testB);
      break;
    case EMERGENCY_STOP_BLINK:
      // Handled in update()
      break;
    default:
      break;
  }
}

void StatusLED::setTestColor(int r, int g, int b) {
  _state = LED_TEST;
  _testR = r;
  _testG = g;
  _testB = b;
  setColor(r, g, b);
}

void StatusLED::blinkEmergencyStop() {
  _previousState = _state;
  _state = EMERGENCY_STOP_BLINK;
  _blinkCount = 0;
  _blinkStartTime = millis();
}

void StatusLED::update() {
  if (_state == WIFI_CONNECTING) {
    // Sine-based breathing on red channel, ~2s cycle
    setColor(breathingBrightness(millis()), 0, 0);
  }
  else if (_state == EMERGENCY_STOP_BLINK) {
    // Blink magenta 4 times: 150ms on, 150ms off per blink
    unsigned long elapsed = millis() - _blinkStartTime;
    const unsigned long BLINK_ON = 150;
    const unsigned long BLINK_OFF = 150;
    const unsigned long BLINK_CYCLE = BLINK_ON + BLINK_OFF;
    const int TOTAL_BLINKS = 4;

    if (!isBlinkSequenceDone(elapsed, BLINK_CYCLE, TOTAL_BLINKS)) {
      if (isBlinkFrameOn(elapsed, BLINK_ON, BLINK_OFF)) {
        setColor(1000, 0, 1000);  // Magenta ON
      } else {
        setColor(0, 0, 0);        // OFF
      }
    } else {
      // Blink sequence complete — restore previous state
      _state = _previousState;
      setState(_state);
    }
  }
}
