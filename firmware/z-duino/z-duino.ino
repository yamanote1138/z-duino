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

#define VERSION "2.3.0"

// analogWrite on ESP8266 is software PWM sharing one hardware timer across
// all 4 active channels (motor + R/G/B status LED). Above ~40kHz the
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

// Status LED pin assignments (common cathode RGB)
int ledR = D5;   // GPIO14 - Red cathode
int ledG = D6;   // GPIO12 - Green cathode
int ledB = D7;   // GPIO13 - Blue cathode

// State
float currentSpeed = 0.0;
bool currentDirection = true; // true = forward
unsigned long lastMessageTime = 0;
const unsigned long SAFETY_TIMEOUT = 30000; // 30 seconds
int connectedClients = 0;
bool invertDirection = false;

// Servers
ESP8266WebServer server(80);
WebSocketsServer socket(81);

// Motor
Motor motor(pwmA, aIn1, aIn2);

// Status LED
StatusLED led(ledR, ledG, ledB);

void applyLedStatus() {
  if (connectedClients > 0) {
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

  String json;
  serializeJson(doc, json);
  return json;
}

void broadcastStatus() {
  String json = buildStatusJson();
  socket.broadcastTXT(json);
}

void handleWebSocketMessage(uint8_t num, uint8_t *payload, size_t length) {
  lastMessageTime = millis();

  Command cmd = parseCommand((const char*)payload, length);

  switch (cmd.type) {
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
      Serial.printf("LED test: r=%d g=%d b=%d\n", cmd.ledR, cmd.ledG, cmd.ledB);
      break;

    case CMD_LED_AUTO:
      applyLedStatus();
      Serial.println("LED: auto status resumed");
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
    case WStype_DISCONNECTED:
      Serial.printf("[%u] Disconnected\n", num);
      connectedClients--;
      if (connectedClients <= 0) {
        connectedClients = 0;
      }
      applyLedStatus();
      break;

    case WStype_CONNECTED:
      Serial.printf("[%u] Connected\n", num);
      lastMessageTime = millis();
      connectedClients++;
      applyLedStatus();
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

  // Safety timeout: stop motor if no messages received
  if (currentSpeed > 0.0 && (millis() - lastMessageTime > SAFETY_TIMEOUT)) {
    Serial.println("Safety timeout - stopping motor");
    currentSpeed = 0.0;
    applyMotorState();
    broadcastStatus();
  }
}
