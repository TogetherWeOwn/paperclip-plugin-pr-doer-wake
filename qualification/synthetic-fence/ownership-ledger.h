#ifndef SYNTHETIC_OWNERSHIP_LEDGER_H
#define SYNTHETIC_OWNERSHIP_LEDGER_H

#include <stddef.h>
#include <sys/types.h>

/* Accounting only, not a containment boundary. One serialized supervisor must
 * block SIGCHLD across fork and registration, own every consuming wait, and
 * keep the ledger alive for its entire lifetime. The owner must prevent aliasing
 * and reuse of live descriptors across records. No handles may outlive it. */
typedef struct ownership_ledger ownership_ledger;
typedef struct ownership_record ownership_record;

typedef enum {
    OWN_NEW, OWN_FORKED, OWN_PINNED, OWN_ENROLLED, OWN_VERIFIED,
    OWN_RELEASED, OWN_REAPED
} ownership_state;

typedef struct {
    ownership_state state;
    pid_t pid;
    int gate_fd;
    int pidfd;
    int status;
    int has_status;
} ownership_receipt;

typedef struct {
    pid_t pid;
    int status;
} ownership_unknown;

/* Records and unknown-status slots are retained and never reused. PID reuse
 * within one ledger poisons it; later statuses for that PID stay ambiguous. */
ownership_ledger *ownership_create(size_t capacity, size_t unknown_capacity);
ownership_record *ownership_reserve(ownership_ledger *ledger);
/* Register returns 0 for a valid accepted input, 1 for an accepted input
 * that poisons the ledger, and -1 for an unaccepted input. The caller must
 * retain every unaccepted PID and descriptor; no resource ownership moves. */
int ownership_register(ownership_ledger *ledger, ownership_record *record,
                       pid_t pid, int gate_fd, int pidfd);
int ownership_advance(ownership_ledger *ledger, ownership_record *record,
                      ownership_state next);
/* Trusted-owner observations only; no kernel wait is performed. A status
 * returns 0 if accepted (even if it poisons the ledger), -1 if unaccepted.
 * The caller retains any unaccepted input. Before a consuming wait, the owner
 * must verify unknown_count is below the configured unknown capacity, or retain
 * the result elsewhere. No-ready is never completion.
 * ECHILD returns 1 for complete accounting, 0 otherwise; neither proves
 * namespace drainage. These calls do not synchronize concurrent access. */
int ownership_observe_status(ownership_ledger *ledger, pid_t pid, int status);
int ownership_observe_no_ready(ownership_ledger *ledger);
int ownership_observe_echild(ownership_ledger *ledger);
void ownership_poison(ownership_ledger *ledger);
int ownership_is_poisoned(const ownership_ledger *ledger);
int ownership_snapshot(ownership_ledger *ledger, const ownership_record *record,
                       ownership_receipt *receipt);
size_t ownership_unknown_count(const ownership_ledger *ledger);
int ownership_unknown_snapshot(const ownership_ledger *ledger, size_t index,
                               ownership_unknown *status);

#endif
