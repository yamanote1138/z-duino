#include <unity.h>
#include <Command.h>
#include <string.h>
#include <string>


Command parse(const char* json) {
  return parseCommand(json, strlen(json));
}

void test_speed_command(void) {
  Command c = parse("{\"cmd\":\"speed\",\"value\":0.5}");
  TEST_ASSERT_EQUAL(CMD_SPEED, c.type);
  TEST_ASSERT_EQUAL_FLOAT(0.5f, c.speed);
}

void test_speed_defaults_to_zero_when_missing(void) {
  Command c = parse("{\"cmd\":\"speed\"}");
  TEST_ASSERT_EQUAL(CMD_SPEED, c.type);
  TEST_ASSERT_EQUAL_FLOAT(0.0f, c.speed);
}

void test_speed_clamps_above_one(void) {
  Command c = parse("{\"cmd\":\"speed\",\"value\":5.0}");
  TEST_ASSERT_EQUAL(CMD_SPEED, c.type);
  TEST_ASSERT_EQUAL_FLOAT(1.0f, c.speed);
}

void test_speed_clamps_below_zero(void) {
  Command c = parse("{\"cmd\":\"speed\",\"value\":-2.0}");
  TEST_ASSERT_EQUAL(CMD_SPEED, c.type);
  TEST_ASSERT_EQUAL_FLOAT(0.0f, c.speed);
}

void test_direction_command(void) {
  Command c = parse("{\"cmd\":\"direction\",\"value\":false}");
  TEST_ASSERT_EQUAL(CMD_DIRECTION, c.type);
  TEST_ASSERT_FALSE(c.boolValue);
}

void test_direction_defaults_to_true_when_missing(void) {
  Command c = parse("{\"cmd\":\"direction\"}");
  TEST_ASSERT_EQUAL(CMD_DIRECTION, c.type);
  TEST_ASSERT_TRUE(c.boolValue);
}

void test_stop_command(void) {
  Command c = parse("{\"cmd\":\"stop\"}");
  TEST_ASSERT_EQUAL(CMD_STOP, c.type);
}

void test_invert_command(void) {
  Command c = parse("{\"cmd\":\"invert\",\"value\":true}");
  TEST_ASSERT_EQUAL(CMD_INVERT, c.type);
  TEST_ASSERT_TRUE(c.boolValue);
}

void test_invert_defaults_to_false_when_missing(void) {
  Command c = parse("{\"cmd\":\"invert\"}");
  TEST_ASSERT_EQUAL(CMD_INVERT, c.type);
  TEST_ASSERT_FALSE(c.boolValue);
}

void test_led_command(void) {
  Command c = parse("{\"cmd\":\"led\",\"r\":100,\"g\":200,\"b\":300}");
  TEST_ASSERT_EQUAL(CMD_LED, c.type);
  TEST_ASSERT_EQUAL(100, c.ledR);
  TEST_ASSERT_EQUAL(200, c.ledG);
  TEST_ASSERT_EQUAL(300, c.ledB);
}

void test_led_defaults_to_zero_when_missing(void) {
  Command c = parse("{\"cmd\":\"led\"}");
  TEST_ASSERT_EQUAL(CMD_LED, c.type);
  TEST_ASSERT_EQUAL(0, c.ledR);
  TEST_ASSERT_EQUAL(0, c.ledG);
  TEST_ASSERT_EQUAL(0, c.ledB);
}

void test_led_auto_command(void) {
  Command c = parse("{\"cmd\":\"led_auto\"}");
  TEST_ASSERT_EQUAL(CMD_LED_AUTO, c.type);
}

void test_ping_command(void) {
  Command c = parse("{\"cmd\":\"ping\"}");
  TEST_ASSERT_EQUAL(CMD_PING, c.type);
}

void test_malformed_json_is_invalid(void) {
  Command c = parse("{not valid json");
  TEST_ASSERT_EQUAL(CMD_INVALID_JSON, c.type);
}

void test_missing_cmd_field_is_unknown(void) {
  Command c = parse("{\"value\":0.5}");
  TEST_ASSERT_EQUAL(CMD_UNKNOWN, c.type);
}

void test_unrecognized_cmd_is_unknown(void) {
  Command c = parse("{\"cmd\":\"launch_missiles\"}");
  TEST_ASSERT_EQUAL(CMD_UNKNOWN, c.type);
}


void test_hello_from_a_sensor(void) {
  Command c = parse("{\"cmd\":\"hello\",\"role\":\"sensor\",\"version\":\"1.0.0\"}");
  TEST_ASSERT_EQUAL(CMD_HELLO, c.type);
  TEST_ASSERT_TRUE(c.isSensor);
  TEST_ASSERT_FALSE(parse("{\"cmd\":\"hello\",\"role\":\"app\"}").isSensor);
}

void test_beam_calibrate_command(void) {
  TEST_ASSERT_EQUAL(CMD_BEAM_CALIBRATE, parse("{\"cmd\":\"beam_calibrate\"}").type);
}

void test_beam_measured(void) {
  Command c = parse("{\"cmd\":\"beam\",\"event\":\"measured\",\"n\":150,\"median\":747,\"mean\":746.5,\"sd\":6.5,\"min\":735,\"max\":754}");
  TEST_ASSERT_EQUAL(CMD_BEAM, c.type);
  TEST_ASSERT_EQUAL_STRING("measured", c.beam.event);
  TEST_ASSERT_EQUAL(747, c.beam.median);
  TEST_ASSERT_EQUAL(735, c.beam.min);
  TEST_ASSERT_EQUAL(754, c.beam.max);
  TEST_ASSERT_EQUAL(150, c.beam.n);
  TEST_ASSERT_EQUAL_FLOAT(6.5f, c.beam.sd);
}

void test_beam_heartbeat(void) {
  Command c = parse("{\"cmd\":\"beam\",\"event\":\"heartbeat\",\"state\":\"blocked\",\"level\":231,\"calibrated\":true}");
  TEST_ASSERT_EQUAL_STRING("heartbeat", c.beam.event);
  TEST_ASSERT_EQUAL_STRING("blocked", c.beam.state);
  TEST_ASSERT_EQUAL(231, c.beam.level);
  TEST_ASSERT_TRUE(c.beam.calibrated);
}

void test_beam_calibration_failed(void) {
  Command c = parse("{\"cmd\":\"beam\",\"event\":\"calibration_failed\",\"error\":\"only 40 counts apart\"}");
  TEST_ASSERT_EQUAL_STRING("only 40 counts apart", c.beam.error);
}

static std::string relay(const char* in, bool moving, bool forward) {
  char out[256]; size_t n = relayBeam(in, strlen(in), moving, forward, out, sizeof(out));
  return std::string(out, n);
}

void test_relay_labels_a_break_while_moving(void) {
  std::string r = relay("{\"cmd\":\"beam\",\"event\":\"break\",\"t\":12.5,\"level\":231}", true, true);
  TEST_ASSERT_EQUAL_STRING("{\"event\":\"break\",\"t\":12.5,\"level\":231,\"type\":\"beam\",\"direction\":\"forward\",\"edge\":\"nose\"}", r.c_str());
  r = relay("{\"cmd\":\"beam\",\"event\":\"restore\",\"t\":12.5}", true, false);
  TEST_ASSERT_NOT_NULL(strstr(r.c_str(), "\"edge\":\"nose\""));
  TEST_ASSERT_NOT_NULL(strstr(r.c_str(), "\"direction\":\"reverse\""));
}

void test_relay_leaves_events_unlabeled_at_a_standstill(void) {
  std::string r = relay("{\"cmd\":\"beam\",\"event\":\"break\",\"t\":12.5}", false, true);
  TEST_ASSERT_NULL(strstr(r.c_str(), "edge"));
  TEST_ASSERT_NOT_NULL(strstr(r.c_str(), "\"type\":\"beam\""));
  TEST_ASSERT_NULL(strstr(r.c_str(), "cmd"));
}

void test_relay_gives_a_pass_its_direction_only(void) {
  std::string r = relay("{\"cmd\":\"beam\",\"event\":\"pass\",\"durationMs\":500}", true, true);
  TEST_ASSERT_NULL(strstr(r.c_str(), "edge"));
  TEST_ASSERT_NOT_NULL(strstr(r.c_str(), "\"direction\":\"forward\""));
}

void test_relay_of_bad_json_is_empty(void) {
  TEST_ASSERT_EQUAL(0, relay("{nope", true, true).length());
}

void test_which_commands_end_a_calibration(void) {
  TEST_ASSERT_TRUE(abortsCalibration(CMD_SPEED));
  TEST_ASSERT_TRUE(abortsCalibration(CMD_DIRECTION));
  TEST_ASSERT_TRUE(abortsCalibration(CMD_STOP));
  TEST_ASSERT_TRUE(abortsCalibration(CMD_INVERT));
  TEST_ASSERT_FALSE(abortsCalibration(CMD_PING));
  TEST_ASSERT_FALSE(abortsCalibration(CMD_LED));
  TEST_ASSERT_FALSE(abortsCalibration(CMD_BEAM_CALIBRATE));
}

int main(int argc, char **argv) {
  UNITY_BEGIN();
  RUN_TEST(test_speed_command);
  RUN_TEST(test_speed_defaults_to_zero_when_missing);
  RUN_TEST(test_speed_clamps_above_one);
  RUN_TEST(test_speed_clamps_below_zero);
  RUN_TEST(test_direction_command);
  RUN_TEST(test_direction_defaults_to_true_when_missing);
  RUN_TEST(test_stop_command);
  RUN_TEST(test_invert_command);
  RUN_TEST(test_invert_defaults_to_false_when_missing);
  RUN_TEST(test_led_command);
  RUN_TEST(test_led_defaults_to_zero_when_missing);
  RUN_TEST(test_led_auto_command);
  RUN_TEST(test_ping_command);
  RUN_TEST(test_malformed_json_is_invalid);
  RUN_TEST(test_missing_cmd_field_is_unknown);
  RUN_TEST(test_unrecognized_cmd_is_unknown);
  RUN_TEST(test_hello_from_a_sensor);
  RUN_TEST(test_beam_calibrate_command);
  RUN_TEST(test_beam_measured);
  RUN_TEST(test_beam_heartbeat);
  RUN_TEST(test_beam_calibration_failed);
  RUN_TEST(test_relay_labels_a_break_while_moving);
  RUN_TEST(test_relay_leaves_events_unlabeled_at_a_standstill);
  RUN_TEST(test_relay_gives_a_pass_its_direction_only);
  RUN_TEST(test_relay_of_bad_json_is_empty);
  RUN_TEST(test_which_commands_end_a_calibration);
  return UNITY_END();
}
