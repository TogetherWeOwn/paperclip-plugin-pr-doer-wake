#ifndef SYNTHETIC_FENCE_GATED_LAUNCH_H
#define SYNTHETIC_FENCE_GATED_LAUNCH_H

#include <stddef.h>
#include <sys/types.h>
#include <time.h>

/* The caller owns this record, including on failure. Initialize via launch. */
struct sf_child {
    pid_t pid;       /* > 0 until reaped; never use after another waiter reaps */
    int pidfd;       /* -1 if unavailable or already closed */
    int poisoned;    /* irreversible for the phase */
    int wait_status;
    int reaped;
};

/* Pure, bounded parser. 1 = present exactly once; 0 = absent; -1 = malformed. */
int sf_cgroup_contains(const char *bytes, size_t length, pid_t pid);

/*
 * Single-threaded PID-1 supervisor only. SIGCHLD must be blocked before entry;
 * no other waiter or SIGCHLD handler may reap. The caller holds exclusive phase
 * ownership and has already recorded the launch intent. All inputs are trusted.
 * deadline is an absolute CLOCK_MONOTONIC deadline, also used on failure cleanup.
 * A zero return means gate released, NOT exec/readiness/qualification success.
 * On failure the phase is poisoned. If !reaped and pid > 0, retain the record
 * and continue bounded containment/reaping; never admit a subsequent phase.
 */
int sf_gated_launch(struct sf_child *child, int cli_cgroup_dirfd, int executable_fd,
                    char *const argv[], char *const envp[],
                    const struct timespec *deadline,
                    int (*record_child)(const struct sf_child *, void *),
                    void *record_context);

#endif
