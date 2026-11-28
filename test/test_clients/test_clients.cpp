#include <unity.h>
#include <Clients.h>

void test_a_new_connection_counts_only_after_a_message(void) {
  Clients c;
  c.connected(0);
  TEST_ASSERT_EQUAL(0, c.people());
  TEST_ASSERT_FALSE(c.feedsSafety(0));
  c.message(0, false);
  TEST_ASSERT_EQUAL(1, c.people());
  TEST_ASSERT_TRUE(c.feedsSafety(0));
}

void test_a_sensor_never_counts_or_feeds_safety(void) {
  Clients c;
  c.connected(1);
  c.message(1, true);
  TEST_ASSERT_EQUAL(0, c.people());
  TEST_ASSERT_EQUAL(1, c.sensor());
  c.message(1, false);
  TEST_ASSERT_EQUAL(0, c.people());
  TEST_ASSERT_FALSE(c.feedsSafety(1));
}

void test_a_second_sensor_replaces_the_first(void) {
  Clients c;
  c.connected(1); c.message(1, true);
  c.connected(2); c.message(2, true);
  TEST_ASSERT_EQUAL(2, c.sensor());
  TEST_ASSERT_FALSE(c.feedsSafety(1));
  TEST_ASSERT_EQUAL(0, c.people());
}

void test_disconnects(void) {
  Clients c;
  c.connected(0); c.message(0, false);
  c.connected(1); c.message(1, true);
  c.disconnected(1);
  TEST_ASSERT_EQUAL(-1, c.sensor());
  c.disconnected(0);
  TEST_ASSERT_EQUAL(0, c.people());
  c.disconnected(7);
  TEST_ASSERT_EQUAL(0, c.people());
}

void test_out_of_range_ids_are_ignored(void) {
  Clients c;
  c.connected(200); c.message(200, false);
  TEST_ASSERT_EQUAL(0, c.people());
  TEST_ASSERT_FALSE(c.feedsSafety(200));
}

int main(int argc, char** argv) {
  UNITY_BEGIN();
  RUN_TEST(test_a_new_connection_counts_only_after_a_message);
  RUN_TEST(test_a_sensor_never_counts_or_feeds_safety);
  RUN_TEST(test_a_second_sensor_replaces_the_first);
  RUN_TEST(test_disconnects);
  RUN_TEST(test_out_of_range_ids_are_ignored);
  return UNITY_END();
}
