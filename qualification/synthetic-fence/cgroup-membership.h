#ifndef SYNTHETIC_FENCE_CGROUP_MEMBERSHIP_H
#define SYNTHETIC_FENCE_CGROUP_MEMBERSHIP_H

#include <stddef.h>
#include <sys/types.h>

/* Parses exactly length bytes: 1 = present once; 0 = absent; -1 = malformed. */
int sf_cgroup_contains(const char *bytes, size_t length, pid_t pid);

#endif
