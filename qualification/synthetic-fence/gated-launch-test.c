#include "gated-launch.h"
#include <assert.h>
#include <errno.h>
#include <string.h>

static int record_child(const struct sf_child *child, void *context)
{
    (void)child;
    *(int *)context = 1;
    return 0;
}

static void check_rejected_inputs(void)
{
    struct sf_child child;
    struct timespec invalid_deadline = {0, 1000000000L};
    char *argv[] = {"inert", NULL};
    char *envp[] = {NULL};
    int recorded = 0;

    memset(&child, 0x5a, sizeof(child));
    errno = 0;
    assert(sf_gated_launch(&child, -1, -1, argv, envp, &invalid_deadline,
                           record_child, &recorded) == -1);
    assert(errno == EINVAL);
    assert(child.poisoned == 1 && child.pid == 0 && child.pidfd == -1);
    assert(child.reaped == 0 && recorded == 0);

    errno = 0;
    assert(sf_gated_launch(NULL, -1, -1, argv, envp, &invalid_deadline,
                           record_child, &recorded) == -1);
    assert(errno == EINVAL && recorded == 0);
}

static void check(const char *s, pid_t pid, int expected)
{
    assert(sf_cgroup_contains(s, strlen(s), pid) == expected);
}

int main(void)
{
    check_rejected_inputs();
    check("", 1, 0);
    check("1\n42\n300\n", 42, 1);
    check("142\n", 42, 0);
    check("42\n42\n", 42, -1);
    check("42", 42, -1);
    check("0\n", 42, -1);
    check("-1\n", 42, -1);
    check("2147483648\n", 42, -1);
    check("4 2\n", 42, -1);
    assert(sf_cgroup_contains(NULL, 0, 1) == -1);
    assert(sf_cgroup_contains("1\n", 2, 0) == -1);
    return 0;
}
