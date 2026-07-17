#include <unity.h>
#include <LedTiming.h>

// breathingBrightness: sine wave over a 2000ms cycle, 0-1000 range.
// Use a small tolerance since it's floating-point math truncated to int.

void test_breathing_at_cycle_start_is_trough(void) {
  TEST_ASSERT_INT_WITHIN(2, 0, breathingBrightness(0));
}

void test_breathing_at_quarter_cycle_is_midpoint(void) {
  TEST_ASSERT_INT_WITHIN(2, 500, breathingBrightness(500));
}

void test_breathing_at_half_cycle_is_peak(void) {
  TEST_ASSERT_INT_WITHIN(2, 1000, breathingBrightness(1000));
}

void test_breathing_at_three_quarter_cycle_is_midpoint(void) {
  TEST_ASSERT_INT_WITHIN(2, 500, breathingBrightness(1500));
}

void test_breathing_wraps_around_at_full_cycle(void) {
  TEST_ASSERT_INT_WITHIN(2, 0, breathingBrightness(2000));
}

void test_breathing_wraps_across_multiple_cycles(void) {
  // 500ms into the 3rd cycle should look the same as 500ms into the 1st
  TEST_ASSERT_INT_WITHIN(2, breathingBrightness(500), breathingBrightness(4500));
}

// isBlinkFrameOn: 150ms on, 150ms off per cycle

void test_blink_is_on_at_cycle_start(void) {
  TEST_ASSERT_TRUE(isBlinkFrameOn(0, 150, 150));
}

void test_blink_is_on_just_before_off_threshold(void) {
  TEST_ASSERT_TRUE(isBlinkFrameOn(149, 150, 150));
}

void test_blink_is_off_at_on_threshold(void) {
  TEST_ASSERT_FALSE(isBlinkFrameOn(150, 150, 150));
}

void test_blink_is_off_just_before_next_cycle(void) {
  TEST_ASSERT_FALSE(isBlinkFrameOn(299, 150, 150));
}

void test_blink_is_on_again_at_next_cycle(void) {
  TEST_ASSERT_TRUE(isBlinkFrameOn(300, 150, 150));
}

// isBlinkSequenceDone: 300ms/cycle, 4 total blinks = 1200ms sequence

void test_sequence_not_done_at_start(void) {
  TEST_ASSERT_FALSE(isBlinkSequenceDone(0, 300, 4));
}

void test_sequence_not_done_in_final_cycle(void) {
  TEST_ASSERT_FALSE(isBlinkSequenceDone(1199, 300, 4));
}

void test_sequence_done_exactly_at_boundary(void) {
  TEST_ASSERT_TRUE(isBlinkSequenceDone(1200, 300, 4));
}

void test_sequence_done_well_after_boundary(void) {
  TEST_ASSERT_TRUE(isBlinkSequenceDone(5000, 300, 4));
}

int main(int argc, char **argv) {
  UNITY_BEGIN();
  RUN_TEST(test_breathing_at_cycle_start_is_trough);
  RUN_TEST(test_breathing_at_quarter_cycle_is_midpoint);
  RUN_TEST(test_breathing_at_half_cycle_is_peak);
  RUN_TEST(test_breathing_at_three_quarter_cycle_is_midpoint);
  RUN_TEST(test_breathing_wraps_around_at_full_cycle);
  RUN_TEST(test_breathing_wraps_across_multiple_cycles);
  RUN_TEST(test_blink_is_on_at_cycle_start);
  RUN_TEST(test_blink_is_on_just_before_off_threshold);
  RUN_TEST(test_blink_is_off_at_on_threshold);
  RUN_TEST(test_blink_is_off_just_before_next_cycle);
  RUN_TEST(test_blink_is_on_again_at_next_cycle);
  RUN_TEST(test_sequence_not_done_at_start);
  RUN_TEST(test_sequence_not_done_in_final_cycle);
  RUN_TEST(test_sequence_done_exactly_at_boundary);
  RUN_TEST(test_sequence_done_well_after_boundary);
  return UNITY_END();
}
