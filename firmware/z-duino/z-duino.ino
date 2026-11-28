#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <WebSocketsServer.h>
#include <WebSockets.h>
#include <LittleFS.h>
#include <ArduinoJson.h>

#include "Motor.h"
#include "StatusLED.h"
#include <MotorLogic.h>
#include <Command.h>
#include <Clients.h>
#include <BeamCalibration.h>

#define VERSION "2.6.0"

#ifndef CAL_SPEED
#define CAL_SPEED 0.1
#endif

// analogWrite on ESP8266 is software PWM sharing one hardware timer across
// all active channels (the motor, plus R/G/B if a status LED is fitted: 4 at most). Above ~40kHz the
// interrupt load starts contending with the WiFi/WebSocket stack, risking
// jitter and dropped connections.
#if PWM_FREQ > 40000
#error "PWM_FREQ exceeds the 40kHz safe ceiling for this board's shared software-PWM timer"
#endif

// WiFi credentials from secrets.ini
char wifi_ssid[] = WIFI_SSID;
char wifi_pass[] = WIFI_PASS;
char mdns_hostname[] = MDNS_HOSTNAME;
char railroad_name[] = RAILROAD_NAME;

// TB6612FNG pin assignments (Motor A only)
int pwmA = D1;   // GPIO5  - PWMA
int aIn2 = D2;   // GPIO4  - AIN2
int aIn1 = D3;   // GPIO0  - AIN1
int stby = D4;   // GPIO2  - STBY

// Status LED pin assignments (common cathode RGB). Optional: with HAS_STATUS_LED=0 these pins are left alone.
#if HAS_STATUS_LED
int ledR = D5;   // GPIO14 - Red cathode
int ledG = D6;   // GPIO12 - Green cathode
int ledB = D7;   // GPIO13 - Blue cathode
#endif

// State
float currentSpeed = 0.0;
bool currentDirection = true; // true = forward
unsigned long lastMessageTime = 0;
const unsigned long SAFETY_TIMEOUT = 30000; // 30 seconds
Clients clients;   // people count for the LED and the safety timer; the beam sensor never does

// Beam sensor add-on: its latest heartbeat, and the calibration it lets the controller run
BeamCalibration calibration(CAL_SPEED);
unsigned long sensorHeardAt = 0;
bool sensorLost = false;
char beamState[16] = "";
int beamLevel = 0;
bool beamCalibrated = false;
bool invertDirection = false;

// Servers
ESP8266WebServer server(80);
WebSocketsServer socket(81);

// Motor
Motor motor(pwmA, aIn1, aIn2);

// Status LED (a do-nothing stand-in when none is fitted)
#if HAS_STATUS_LED
StatusLED led(ledR, ledG, ledB);
#else
StatusLED led;
#endif

void applyLedStatus() {
  if (clients.people() > 0) {
    led.setState(currentDirection ? ACTIVE_FORWARD : ACTIVE_REVERSE);
  } else {
    led.setState(IDLE);
  }
}

void applyMotorState() {
  MotorDecision decision = decideMotorState(currentSpeed, MAX_PWM, currentDirection, invertDirection);
  switch (decision.action) {
    case MOTOR_STOP:
      motor.stop();
      break;
    case MOTOR_FORWARD:
      motor.forward(decision.pwm);
      break;
    case MOTOR_REVERSE:
      motor.reverse(decision.pwm);
      break;
  }
}

String buildStatusJson() {
  JsonDocument doc;
  doc["type"] = "status";
  doc["name"] = railroad_name;
  doc["speed"] = currentSpeed;
  doc["direction"] = currentDirection;
  doc["connected"] = true;
  // What this controller has fitted, so clients can leave out controls for hardware that is not there.
  // Clients treat a missing "features" (older firmware) as "everything present".
  JsonObject features = doc["features"].to<JsonObject>();
  features["led"] = (bool)HAS_STATUS_LED;
  bool hasSensor = clients.sensor() >= 0;
  features["sensor"] = hasSensor;
  if (hasSensor) {
    JsonObject beam = doc["beam"].to<JsonObject>();
    beam["state"] = sensorLost ? "lost" : beamState;
    beam["level"] = beamLevel;
    beam["calibrated"] = beamCalibrated;
    beam["calibrating"] = calibration.running();
  } else {
    doc["beam"] = nullptr;
  }

  String json;
  serializeJson(doc, json);
  return json;
}

void broadcastStatus() {
  String json = buildStatusJson();
  socket.broadcastTXT(json);
}

// Send to every connection except the beam sensor.
void broadcastPeople(const char* json, size_t len) {
  int s = clients.sensor();
  for (uint8_t i = 0; i < WEBSOCKETS_SERVER_CLIENT_MAX; i++) if (i != s && socket.clientIsConnected(i)) socket.sendTXT(i, json, len);
}

void sendSensor(JsonDocument& doc) {
  int s = clients.sensor();
  if (s < 0) return;
  String json; serializeJson(doc, json);
  socket.sendTXT((uint8_t)s, json);
}

void sendStatsTo(JsonObject o, Stats st) {
  o["n"] = st.n; o["median"] = st.median; o["mean"] = st.mean; o["sd"] = st.sd; o["min"] = st.min; o["max"] = st.max;
}

// Carry out what a calibration step asks for: the motor, messages to the sensor, progress to people.
void applyCalibration(CalOutput o) {
  if (o.motor) {
    currentSpeed = o.speed;
    if (o.speed > 0) currentDirection = o.forward;
    applyMotorState();
    broadcastStatus();
    applyLedStatus();
  }
  if (o.sendMeasure) { JsonDocument d; d["type"] = "beam_measure"; sendSensor(d); }
  if (o.sendWatch) { JsonDocument d; d["type"] = "beam_watch"; d["from"] = o.watchFrom; sendSensor(d); }
  if (o.sendWatchOff) { JsonDocument d; d["type"] = "beam_watch_off"; sendSensor(d); }
  if (o.sendLevels) {
    JsonDocument d; d["type"] = "beam_levels";
    sendStatsTo(d["a"].to<JsonObject>(), calibration.a());
    sendStatsTo(d["b"].to<JsonObject>(), calibration.b());
    sendSensor(d);
  }
  if (o.phaseChanged) {
    JsonDocument d; d["type"] = "beam"; d["event"] = "calibration";
    d["phase"] = calibration.phaseName(); d["detail"] = calibration.detail();
    String json; serializeJson(d, json);
    broadcastPeople(json.c_str(), json.length());
    Serial.printf("Calibration: %s %s\n", calibration.phaseName(), calibration.detail());
    broadcastStatus();
  }
}

void calibrationRefused(uint8_t num, const char* why) {
  JsonDocument d; d["type"] = "beam"; d["event"] = "calibration"; d["phase"] = "failed"; d["detail"] = why;
  String json; serializeJson(d, json);
  socket.sendTXT(num, json);   // only the one who asked: a refusal says nothing about a run already going
}

void sensorGone(const char* why) {
  sensorLost = true;
  applyCalibration(calibration.abort(why));
  const char* lost = "{\"type\":\"beam\",\"event\":\"lost\"}";
  broadcastPeople(lost, strlen(lost));
  broadcastStatus();
}

void handleSensorMessage(uint8_t *payload, size_t length, Command& cmd) {
  if (cmd.type == CMD_HELLO) { applyCalibration(calibration.onSensorHello()); sensorHeardAt = millis(); sensorLost = false; Serial.println("Beam sensor connected"); broadcastStatus(); return; }
  if (cmd.type != CMD_BEAM) return;
  sensorHeardAt = millis();
  const BeamMessage& b = cmd.beam;
  if (!strcmp(b.event, "heartbeat")) {
    bool changed = sensorLost || strcmp(beamState, b.state) != 0 || beamCalibrated != b.calibrated;
    sensorLost = false;
    snprintf(beamState, sizeof(beamState), "%s", b.state);
    beamLevel = b.level; beamCalibrated = b.calibrated;
    if (changed) broadcastStatus();
  } else if (!strcmp(b.event, "measured")) {
    Stats st; st.n = b.n; st.median = b.median; st.mean = b.mean; st.sd = b.sd; st.min = b.min; st.max = b.max;
    applyCalibration(calibration.onMeasured(millis(), st));
  } else if (!strcmp(b.event, "changed")) {
    applyCalibration(calibration.onChanged(millis()));
  } else if (!strcmp(b.event, "calibrated")) {
    beamCalibrated = true;
    applyCalibration(calibration.onResult(true, nullptr));
  } else if (!strcmp(b.event, "calibration_failed")) {
    applyCalibration(calibration.onResult(false, b.error));
  } else if (!strcmp(b.event, "break") || !strcmp(b.event, "restore")) {
    snprintf(beamState, sizeof(beamState), "%s", !strcmp(b.event, "break") ? "blocked" : "clear");
    broadcastStatus();
  }
  char out[384];
  size_t n = relayBeam((const char*)payload, length, currentSpeed > 0, currentDirection, out, sizeof(out));
  if (n) broadcastPeople(out, n);
}

void handleWebSocketMessage(uint8_t num, uint8_t *payload, size_t length) {
  Command cmd = parseCommand((const char*)payload, length);
  clients.message(num, cmd.type == CMD_HELLO && cmd.isSensor);
  if (clients.isSensor(num)) { handleSensorMessage(payload, length, cmd); return; }
  if (clients.feedsSafety(num)) lastMessageTime = millis();
  applyLedStatus();

  // A person taking the throttle during calibration ends it first
  if (calibration.running() && abortsCalibration(cmd.type)) {
    applyCalibration(calibration.abort("stopped"));
  }

  switch (cmd.type) {
    case CMD_BEAM_CALIBRATE: {
      CalOutput o = calibration.start(millis(), clients.sensor() >= 0 && !sensorLost, currentSpeed > 0);
      if (o.error) calibrationRefused(num, o.error);
      else applyCalibration(o);
      break;
    }

    case CMD_SPEED:
      currentSpeed = cmd.speed;
      applyMotorState();
      broadcastStatus();
      break;

    case CMD_DIRECTION:
      currentDirection = cmd.boolValue;
      applyMotorState();
      broadcastStatus();
      applyLedStatus();
      break;

    case CMD_STOP:
      currentSpeed = 0.0;
      applyMotorState();
      broadcastStatus();
      led.blinkEmergencyStop();
      break;

    case CMD_INVERT:
      invertDirection = cmd.boolValue;
      applyMotorState();
      Serial.printf("Direction invert: %s\n", invertDirection ? "on" : "off");
      break;

    case CMD_LED:
      led.setTestColor(cmd.ledR, cmd.ledG, cmd.ledB);
#if HAS_STATUS_LED
      Serial.printf("LED test: r=%d g=%d b=%d\n", cmd.ledR, cmd.ledG, cmd.ledB);
#else
      Serial.println("LED command ignored: no status LED fitted");
#endif
      break;

    case CMD_LED_AUTO:
      applyLedStatus();
#if HAS_STATUS_LED
      Serial.println("LED: auto status resumed");
#endif
      break;

    case CMD_PING: {
      String pong = "{\"type\":\"pong\"}";
      socket.sendTXT(num, pong);
      break;
    }

    case CMD_INVALID_JSON:
      Serial.println("JSON parse error");
      break;

    case CMD_UNKNOWN:
    default:
      break;
  }
}

void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED: {
      Serial.printf("[%u] Disconnected\n", num);
      bool wasSensor = clients.isSensor(num);
      clients.disconnected(num);
      if (wasSensor) sensorGone("the sensor disconnected");
      applyLedStatus();
      break;
    }

    case WStype_CONNECTED:
      Serial.printf("[%u] Connected\n", num);
      clients.connected(num);   // counts as a person only once it says something
      {
        String json = buildStatusJson();
        socket.sendTXT(num, json);
      }
      break;

    case WStype_TEXT:
      handleWebSocketMessage(num, payload, length);
      break;

    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.printf("\n\nZ-Duino v%s starting...\n", VERSION);

  // Enable STBY pin (always on)
  pinMode(stby, OUTPUT);
  digitalWrite(stby, HIGH);

  // PWM config: frequency from secrets.ini (above audible range), 0-1000 range
  analogWriteFreq(PWM_FREQ);
  analogWriteRange(1000);

  // Initialize LittleFS
  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed");
  }

  // Connect to WiFi
  led.setState(WIFI_CONNECTING);
  WiFi.begin(wifi_ssid, wifi_pass);
  Serial.printf("Connecting to %s", wifi_ssid);
  while (WiFi.status() != WL_CONNECTED) {
    led.update();
    delay(50);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected! IP: ");
  Serial.println(WiFi.localIP());
  led.setState(IDLE);

  // Start mDNS
  if (MDNS.begin(mdns_hostname)) {
    Serial.printf("mDNS: http://%s.local\n", mdns_hostname);
    MDNS.addService("http", "tcp", 80);
    MDNS.addService("ws", "tcp", 81);   // the beam sensor finds the controller by this
  }

  // HTTP server: serve frontend from LittleFS
  server.on("/", HTTP_GET, []() {
    File f = LittleFS.open("/index.html", "r");
    if (!f) {
      server.send(500, "text/plain", "index.html not found on LittleFS");
      return;
    }
    server.streamFile(f, "text/html");
    f.close();
  });
  server.onNotFound([]() {
    String path = server.uri();
    if (LittleFS.exists(path)) {
      File f = LittleFS.open(path, "r");
      String contentType = "application/octet-stream";
      if (path.endsWith(".html")) contentType = "text/html";
      else if (path.endsWith(".css")) contentType = "text/css";
      else if (path.endsWith(".js")) contentType = "application/javascript";
      else if (path.endsWith(".woff2")) contentType = "font/woff2";
      server.streamFile(f, contentType);
      f.close();
    } else {
      server.send(404, "text/plain", "Not found: " + path);
    }
  });
  server.begin();
  Serial.println("HTTP server started on port 80");

  // WebSocket server
  socket.begin();
  socket.onEvent(webSocketEvent);
  Serial.println("WebSocket server started on port 81");

  lastMessageTime = millis();
}

void loop() {
  server.handleClient();
  socket.loop();
  MDNS.update();
  led.update();

  // Calibration's own clock, and a sensor that has gone quiet
  if (calibration.running()) applyCalibration(calibration.tick(millis()));
  if (clients.sensor() >= 0 && !sensorLost && millis() - sensorHeardAt > calibration.quietLimitMs()) sensorGone("the sensor went quiet");

  // Safety timeout: stop motor if no person has sent anything (calibration's own creep has its own limits)
  if (currentSpeed > 0.0 && !calibration.moving() && (millis() - lastMessageTime > SAFETY_TIMEOUT)) {
    Serial.println("Safety timeout - stopping motor");
    currentSpeed = 0.0;
    applyMotorState();
    broadcastStatus();
  }
}
