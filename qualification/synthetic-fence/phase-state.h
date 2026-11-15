#ifndef SYNTHETIC_FENCE_PHASE_STATE_H
#define SYNTHETIC_FENCE_PHASE_STATE_H

#include <sys/types.h>

/* Linux only. The caller holds exclusive admission and controls both already
 * opened parent directories and their ancestors for the entire lifetime. The
 * control parent must be owned by the effective uid and have mode 0700; no
 * same-uid adversary or privileged host actor may mutate either parent. The
 * cgroup parent, when supplied, must be an exclusively controlled delegated
 * cgroup-v2 directory. The caller is single-threaded because allocation reads
 * the process-wide umask; a mask denying owner access is rejected before any
 * resource is created. This helper does not prove the environmental facts.
 *
 * Each attempt permanently reserves a 128-bit random identity in the control
 * parent, even on failure. Reservations must never be removed or copied into a
 * new identity domain. Collision is an error, not an invitation to reuse or
 * delete anything. Storage loss/rollback and random identity collision across
 * independently initialized parents are outside this guarantee. Reservations
 * are not fsynced; crash durability and external ownership receipts are the
 * caller's responsibility. A crash or lost descriptors requires poison and
 * independent recovery, never adoption of a directory by name.
 *
 * The struct retains partial ownership after failure; initialize only by
 * phase_state_allocate, and always call phase_state_close. cleanup is non-
 * recursive, verifies directory identity, and fails if contents remain. Call
 * it only after independently verifying namespace reaping, cgroup emptiness,
 * and runtime-state removal; its success is not a teardown receipt. If an
 * owned directory could not be opened, cleanup returns an error and leaves it.
 * No allocation/cleanup operation is safe against a concurrently mutable
 * parent; descriptors are CLOEXEC and must not be exposed to the worker. */
struct phase_state {
    char id[33];
    int control_parent, cgroup_parent;
    int control, cgroup, cli, workload;
    unsigned owned;
};

/* cgroup_parent_fd == -1 omits cgroup creation (inert tests only).
 * On error returns -1 with errno preserved and leaves partial state for cleanup.
 * IDs are safe path components and also suitable as runc container IDs. */
int phase_state_allocate(struct phase_state *s, int control_parent_fd,
                         int cgroup_parent_fd);
int phase_state_cleanup(struct phase_state *s);
void phase_state_close(struct phase_state *s);

#endif
