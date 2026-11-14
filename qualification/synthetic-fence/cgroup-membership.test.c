#include "cgroup-membership.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

static void check(const char *s, pid_t pid, int expected)
{
    assert(sf_cgroup_contains(s, strlen(s), pid) == expected);
}

int main(void)
{
    char max_pid[32];
    const char bytes[] = {'4', '2', '\n', 'x'};
    check("", 1, 0);
    check("1\n42\n300\n", 42, 1);
    check("142\n", 42, 0);
    check("42\n42\n", 42, -1);
    check("42\n042\n", 42, -1);
    check("42\ninvalid\n", 42, -1);
    check("42", 42, -1);
    check("0\n", 42, -1);
    check("-1\n", 42, -1);
    check("2147483648\n", 42, -1);
    check("999999999999999999999999999999999\n", 42, -1);
    check("4 2\n", 42, -1);
    assert(snprintf(max_pid, sizeof(max_pid), "%d\n", INT_MAX) > 0);
    check(max_pid, (pid_t)INT_MAX, 1);
    assert(sf_cgroup_contains(bytes, 3, 42) == 1);
    assert(sf_cgroup_contains(bytes, sizeof(bytes), 42) == -1);
    assert(sf_cgroup_contains("1\n\0", 3, 1) == -1);
    assert(sf_cgroup_contains(NULL, 0, 1) == -1);
    assert(sf_cgroup_contains("1\n", 2, 0) == -1);
    return 0;
}
