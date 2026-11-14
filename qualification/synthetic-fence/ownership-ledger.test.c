#include "ownership-ledger.h"

#include <assert.h>

static void normal(void) {
    ownership_receipt receipt;
    ownership_ledger *ledger = ownership_create(1, 1);
    ownership_record *record = ownership_reserve(ledger);
    assert(record && ownership_register(ledger, record, 42, 3, 4) == 0);
    assert(ownership_observe_no_ready(ledger) == 0);
    assert(ownership_advance(ledger, record, OWN_PINNED) == 0);
    assert(ownership_advance(ledger, record, OWN_ENROLLED) == 0);
    assert(ownership_advance(ledger, record, OWN_VERIFIED) == 0);
    assert(ownership_advance(ledger, record, OWN_RELEASED) == 0);
    assert(ownership_observe_status(ledger, 42, 0) == 0);
    assert(ownership_observe_echild(ledger) == 1);
    assert(!ownership_is_poisoned(ledger));
    assert(ownership_snapshot(ledger, record, &receipt) == 0);
    assert(receipt.state == OWN_REAPED && receipt.has_status);
    assert(ownership_advance(ledger, record, OWN_RELEASED) == -1);
}

static void ambiguous_and_full(void) {
    ownership_unknown unknown;
    ownership_receipt a, b;
    ownership_ledger *ledger = ownership_create(2, 1);
    ownership_record *first = ownership_reserve(ledger);
    ownership_record *second = ownership_reserve(ledger);
    assert(ownership_register(ledger, first, 42, 3, 4) == 0);
    assert(ownership_register(ledger, second, 42, 5, 6) == 1);
    assert(ownership_observe_status(ledger, 42, 9) == 0);
    assert(ownership_unknown_snapshot(ledger, 0, &unknown) == 0);
    assert(unknown.pid == 42 && unknown.status == 9);
    assert(ownership_observe_status(ledger, 77, 0) == -1);
    assert(ownership_unknown_count(ledger) == 1);
    assert(ownership_snapshot(ledger, first, &a) == 0);
    assert(ownership_snapshot(ledger, second, &b) == 0);
    assert(a.pid == 42 && b.pid == 42 && !a.has_status && !b.has_status);
}

static void early_each_state(void) {
    int state, step;
    for (state = OWN_FORKED; state < OWN_RELEASED; ++state) {
        ownership_receipt receipt;
        ownership_ledger *ledger = ownership_create(1, 1);
        ownership_record *record = ownership_reserve(ledger);
        assert(ownership_register(ledger, record, 51, 3, 4) == 0);
        for (step = OWN_PINNED; step <= state; ++step)
            assert(ownership_advance(ledger, record, (ownership_state)step) == 0);
        assert(ownership_observe_no_ready(ledger) == 0);
        assert(ownership_observe_status(ledger, 51, 0) == 0);
        assert(ownership_is_poisoned(ledger));
        assert(ownership_snapshot(ledger, record, &receipt) == 0);
        assert(receipt.pid == 51 && receipt.state == OWN_REAPED && receipt.has_status);
        assert(ownership_observe_echild(ledger) == 0);
    }
}

static void rejected_registration_and_capacity(void) {
    ownership_receipt receipt;
    ownership_ledger *ledger = ownership_create(2, 2);
    ownership_record *a = ownership_reserve(ledger);
    ownership_record *b = ownership_reserve(ledger);
    assert(ownership_register(ledger, a, 61, 3, 4) == 0);
    /* The second input is rejected and remains the caller's responsibility. */
    assert(ownership_register(ledger, a, 62, 5, 6) == -1);
    assert(ownership_snapshot(ledger, a, &receipt) == 0);
    assert(receipt.pid == 61 && receipt.gate_fd == 3 && receipt.pidfd == 4);
    assert(ownership_register(ledger, b, 63, 7, 8) == 1);
    assert(!ownership_reserve(ledger));
    assert(ownership_observe_status(ledger, 61, 0) == 0);
    assert(ownership_observe_status(ledger, 63, 0) == 0);
    assert(ownership_snapshot(ledger, b, &receipt) == 0);
    assert(receipt.pid == 63 && receipt.has_status);
}

static void unknown_and_limits(void) {
    ownership_unknown evidence;
    ownership_ledger *ledger = ownership_create(1, 1);
    ownership_record *record = ownership_reserve(ledger);
    assert(!ownership_reserve(ledger));
    assert(ownership_register(ledger, record, 71, 3, 4) == 1);
    assert(ownership_observe_echild(ledger) == 0);
    assert(ownership_observe_status(ledger, 99, 123) == 0);
    assert(ownership_unknown_snapshot(ledger, 0, &evidence) == 0);
    assert(evidence.pid == 99 && evidence.status == 123);
    /* The caller retains this unaccepted event. */
    assert(ownership_observe_status(ledger, 71, 0) == -1);
    assert(ownership_unknown_count(ledger) == 1);
    assert(ownership_observe_echild(ledger) == 0);
    assert(!ownership_create(0, 1));
    assert(!ownership_create(1, 0));
    assert(!ownership_create(257, 1));
}

static void invalid_and_duplicate_events(void) {
    ownership_receipt receipt;
    ownership_unknown evidence;
    ownership_ledger *ledger = ownership_create(1, 2);
    ownership_ledger *other = ownership_create(1, 1);
    ownership_record *record = ownership_reserve(ledger);
    assert(ownership_register(other, record, 81, 3, 4) == -1);
    assert(ownership_snapshot(ledger, record, &receipt) == 0);
    assert(receipt.state == OWN_NEW && receipt.pid == 0);
    assert(ownership_register(ledger, record, 0, 3, 4) == -1);
    assert(ownership_register(ledger, record, 81, 3, -1) == 1);
    assert(ownership_snapshot(ledger, record, &receipt) == 0);
    assert(receipt.pid == 81 && receipt.pidfd == -1);
    /* A stopped status is not a terminal receipt. */
    assert(ownership_observe_status(ledger, 81, 0x7f) == 0);
    assert(ownership_snapshot(ledger, record, &receipt) == 0);
    assert(!receipt.has_status && receipt.state == OWN_FORKED);
    assert(ownership_observe_status(ledger, 81, 0) == 0);
    assert(ownership_observe_status(ledger, 81, 0) == 0);
    assert(ownership_unknown_snapshot(ledger, 1, &evidence) == 0);
    assert(evidence.pid == 81 && evidence.status == 0);
    assert(ownership_snapshot(ledger, record, &receipt) == 0);
    assert(receipt.has_status && receipt.state == OWN_REAPED);
}

static void reused_pid_remains_ambiguous(void) {
    ownership_receipt receipt;
    ownership_unknown evidence;
    ownership_ledger *ledger = ownership_create(2, 1);
    ownership_record *first = ownership_reserve(ledger);
    ownership_record *second = ownership_reserve(ledger);
    assert(ownership_register(ledger, first, 91, 3, 4) == 0);
    assert(ownership_advance(ledger, first, OWN_PINNED) == 0);
    assert(ownership_advance(ledger, first, OWN_ENROLLED) == 0);
    assert(ownership_advance(ledger, first, OWN_VERIFIED) == 0);
    assert(ownership_advance(ledger, first, OWN_RELEASED) == 0);
    assert(ownership_observe_status(ledger, 91, 0) == 0);
    assert(ownership_register(ledger, second, 91, 5, 6) == 1);
    assert(ownership_observe_status(ledger, 91, 9) == 0);
    assert(ownership_unknown_snapshot(ledger, 0, &evidence) == 0);
    assert(evidence.pid == 91 && evidence.status == 9);
    assert(ownership_snapshot(ledger, second, &receipt) == 0);
    assert(receipt.pid == 91 && !receipt.has_status);
    assert(ownership_observe_echild(ledger) == 0);
}

int main(void) {
    reused_pid_remains_ambiguous();
    invalid_and_duplicate_events();
    early_each_state();
    rejected_registration_and_capacity();
    unknown_and_limits();
    normal();
    ambiguous_and_full();
    return 0;
}
