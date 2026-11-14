#include "cgroup-membership.h"

#include <limits.h>

int sf_cgroup_contains(const char *s, size_t n, pid_t pid)
{
    size_t i = 0;
    int found = 0;
    if (!s || pid <= 0) return -1;
    while (i < n) {
        unsigned long value = 0;
        size_t start = i;
        while (i < n && s[i] >= '0' && s[i] <= '9') {
            unsigned digit = (unsigned)(s[i++] - '0');
            if (value > ((unsigned long)INT_MAX - digit) / 10) return -1;
            value = value * 10 + digit;
        }
        if (i == start || value == 0 || i == n || s[i++] != '\n') return -1;
        if (value == (unsigned long)pid && ++found > 1) return -1;
    }
    return found;
}
