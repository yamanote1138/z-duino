#include <unity.h>
#include <MotorLogic.h>

void test_zero_speed_stops(void) {
  MotorDecision d = decideMotorState(0.0f, 500, true, false);
  TEST_ASSERT_EQUAL(MOTOR_STOP, d.action);
  TEST_ASSERT_EQUAL(0, d.pwm);
}

void test_forward_at_full_speed(void) {
  MotorDecision d = decideMotorState(1.0f, 500, true, false);
  TEST_ASSERT_EQUAL(MOTOR_FORWARD, d.action);
  TEST_ASSERT_EQUAL(500, d.pwm);
}

void test_reverse_when_direction_false(void) {
  MotorDecision d = decideMotorState(0.5f, 1000, false, false);
  TEST_ASSERT_EQUAL(MOTOR_REVERSE, d.action);
  TEST_ASSERT_EQUAL(500, d.pwm);
}

void test_invert_flips_forward_to_reverse(void) {
  MotorDecision d = decideMotorState(0.5f, 1000, true, true);
  TEST_ASSERT_EQUAL(MOTOR_REVERSE, d.action);
  TEST_ASSERT_EQUAL(500, d.pwm);
}

void test_invert_flips_reverse_to_forward(void) {
  MotorDecision d = decideMotorState(0.5f, 1000, false, true);
  TEST_ASSERT_EQUAL(MOTOR_FORWARD, d.action);
  TEST_ASSERT_EQUAL(500, d.pwm);
}

void test_zero_speed_stops_regardless_of_invert(void) {
  MotorDecision d = decideMotorState(0.0f, 500, true, true);
  TEST_ASSERT_EQUAL(MOTOR_STOP, d.action);
  TEST_ASSERT_EQUAL(0, d.pwm);
}

void test_pwm_scales_with_max_pwm(void) {
  MotorDecision d = decideMotorState(0.25f, 800, true, false);
  TEST_ASSERT_EQUAL(MOTOR_FORWARD, d.action);
  TEST_ASSERT_EQUAL(200, d.pwm);
}

int main(int argc, char **argv) {
  UNITY_BEGIN();
  RUN_TEST(test_zero_speed_stops);
  RUN_TEST(test_forward_at_full_speed);
  RUN_TEST(test_reverse_when_direction_false);
  RUN_TEST(test_invert_flips_forward_to_reverse);
  RUN_TEST(test_invert_flips_reverse_to_forward);
  RUN_TEST(test_zero_speed_stops_regardless_of_invert);
  RUN_TEST(test_pwm_scales_with_max_pwm);
  return UNITY_END();
}
