#include "ownership-ledger.h"
#include <stdlib.h>
#include <sys/wait.h>

#define MAX_RECORDS 256

struct ownership_record {
    ownership_receipt receipt;
};

struct ownership_ledger {
    struct ownership_record *records;
    ownership_unknown *unknown;
    size_t capacity, used, unknown_capacity, unknown_used;
    int poisoned;
};

static int fail(ownership_ledger *ledger) {
    if (ledger) ledger->poisoned = 1;
    return -1;
}

static int belongs(const ownership_ledger *ledger, const ownership_record *record) {
    size_t i;
    if (!ledger || !record) return 0;
    for (i = 0; i < ledger->used; ++i)
        if (&ledger->records[i] == record) return 1;
    return 0;
}

ownership_ledger *ownership_create(size_t capacity, size_t unknown_capacity) {
    ownership_ledger *ledger;
    if (!capacity || capacity > MAX_RECORDS || !unknown_capacity || unknown_capacity > MAX_RECORDS) return NULL;
    ledger = calloc(1, sizeof(*ledger));
    if (!ledger) return NULL;
    ledger->records = calloc(capacity, sizeof(*ledger->records));
    ledger->unknown = calloc(unknown_capacity, sizeof(*ledger->unknown));
    if (!ledger->records || !ledger->unknown) {
        free(ledger->unknown);
        free(ledger->records);
        free(ledger);
        return NULL;
    }
    ledger->capacity = capacity;
    ledger->unknown_capacity = unknown_capacity;
    return ledger;
}

ownership_record *ownership_reserve(ownership_ledger *ledger) {
    ownership_record *record;
    if (!ledger || ledger->poisoned) return NULL;
    if (ledger->used == ledger->capacity) {
        fail(ledger);
        return NULL;
    }
    record = &ledger->records[ledger->used++];
    record->receipt.state = OWN_NEW;
    record->receipt.gate_fd = -1;
    record->receipt.pidfd = -1;
    return record;
}

int ownership_register(ownership_ledger *ledger, ownership_record *record,
                       pid_t pid, int gate_fd, int pidfd) {
    size_t i;
    if (!belongs(ledger, record) || record->receipt.state != OWN_NEW || pid <= 0)
        return fail(ledger);
    /* Even a poisoned phase must register a child already forked. */
    record->receipt.pid = pid;
    record->receipt.gate_fd = gate_fd;
    record->receipt.pidfd = pidfd;
    record->receipt.state = OWN_FORKED;
    for (i = 0; i < ledger->used; ++i) {
        ownership_record *other = &ledger->records[i];
        if (other != record && other->receipt.pid == pid)
            ledger->poisoned = 1;
    }
    if (gate_fd < 0 || pidfd < 0 || gate_fd == pidfd) ledger->poisoned = 1;
    return ledger->poisoned ? 1 : 0;
}

int ownership_advance(ownership_ledger *ledger, ownership_record *record,
                      ownership_state next) {
    if (!belongs(ledger, record) || ledger->poisoned ||
        record->receipt.state < OWN_FORKED || record->receipt.state >= OWN_RELEASED ||
        next != record->receipt.state + 1)
        return fail(ledger);
    record->receipt.state = next;
    return 0;
}

static int record_status(ownership_ledger *ledger, pid_t pid, int status) {
    size_t i, matches = 0;
    ownership_record *match = NULL;
    for (i = 0; i < ledger->used; ++i) {
        ownership_record *record = &ledger->records[i];
        if (record->receipt.pid == pid) {
            match = record;
            ++matches;
        }
    }
    if (matches == 1 && !match->receipt.has_status &&
        (WIFEXITED(status) || WIFSIGNALED(status))) {
        ownership_state prior = match->receipt.state;
        match->receipt.status = status;
        match->receipt.has_status = 1;
        match->receipt.state = OWN_REAPED;
        if (prior != OWN_RELEASED) return fail(ledger);
        return 0;
    }
    ledger->unknown[ledger->unknown_used++] = (ownership_unknown){pid, status};
    return fail(ledger);
}

static int check_echild(ownership_ledger *ledger) {
    size_t i;
    for (i = 0; i < ledger->used; ++i) {
        ownership_receipt *r = &ledger->records[i].receipt;
        if (r->state == OWN_NEW || (r->pid > 0 && !r->has_status)) return fail(ledger);
    }
    return ledger->poisoned ? -1 : 0;
}

int ownership_observe_status(ownership_ledger *ledger, pid_t pid, int status) {
    if (!ledger || pid <= 0) return fail(ledger);
    if (ledger->unknown_used == ledger->unknown_capacity) return fail(ledger);
    (void)record_status(ledger, pid, status);
    return 0;
}

int ownership_observe_no_ready(ownership_ledger *ledger) {
    if (!ledger) return -1;
    return 0;
}

int ownership_observe_echild(ownership_ledger *ledger) {
    if (!ledger) return 0;
    return check_echild(ledger) == 0;
}

void ownership_poison(ownership_ledger *ledger) { if (ledger) ledger->poisoned = 1; }
int ownership_is_poisoned(const ownership_ledger *ledger) { return !ledger || ledger->poisoned; }
int ownership_snapshot(ownership_ledger *ledger, const ownership_record *record,
                       ownership_receipt *receipt) {
    if (!belongs(ledger, record) || !receipt) return fail(ledger);
    *receipt = record->receipt;
    return 0;
}
size_t ownership_unknown_count(const ownership_ledger *ledger) {
    return ledger ? ledger->unknown_used : 0;
}
int ownership_unknown_snapshot(const ownership_ledger *ledger, size_t index,
                               ownership_unknown *status) {
    if (!ledger || !status || index >= ledger->unknown_used) return -1;
    *status = ledger->unknown[index];
    return 0;
}
