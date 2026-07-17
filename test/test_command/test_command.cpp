#include <unity.h>
#include <Command.h>
#include <string.h>

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
  return UNITY_END();
}
