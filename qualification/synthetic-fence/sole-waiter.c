/* Benign-only ownership experiment. This is not a containment boundary. */
#define _GNU_SOURCE
#include "ownership-ledger.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/signalfd.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define UNKNOWN_CAPACITY 16
#define DEADLINE_SECONDS 5

static int remaining_ms(const struct timespec *deadline) {
    struct timespec now;
    long long ms;
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return 0;
    ms = (deadline->tv_sec - now.tv_sec) * 1000LL +
         (deadline->tv_nsec - now.tv_nsec) / 1000000LL;
    return ms > 0 ? (int)ms : 0;
}

/* No arguments select a workload: the only child immediately calls _exit. */
int main(int argc, char **argv) {
    ownership_ledger *ledger;
    ownership_record *record;
    ownership_receipt receipt;
    struct sigaction action = {0};
    struct timespec deadline;
    sigset_t mask;
    struct pollfd event;
    pid_t child, result;
    int gate[2], pidfd, status, poisoned = 0, drained = 0, cleaning = 0;
    int interrupted = 0, fault = 0;
    (void)argv;
    if (argc != 1) return 2;
    action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL) < 0 ||
        sigemptyset(&mask) < 0 || sigaddset(&mask, SIGCHLD) < 0 ||
        sigaddset(&mask, SIGTERM) < 0 || sigaddset(&mask, SIGINT) < 0 ||
        sigprocmask(SIG_BLOCK, &mask, NULL) < 0) return 2;
    event.fd = signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
    event.events = POLLIN;
    if (event.fd < 0 || clock_gettime(CLOCK_MONOTONIC, &deadline) < 0) return 2;
    deadline.tv_sec += DEADLINE_SECONDS;
    ledger = ownership_create(1, UNKNOWN_CAPACITY);
    if (!ledger || !(record = ownership_reserve(ledger)) || pipe2(gate, O_CLOEXEC) < 0) return 2;
    child = fork();
    if (child < 0) return 2;
    if (child == 0) {
        close(gate[0]);
        close(gate[1]);
        close(event.fd);
        _exit(0);
    }
    close(gate[0]);
    pidfd = (int)syscall(SYS_pidfd_open, child, 0);
    if (ownership_register(ledger, record, child, gate[1], pidfd) != 0) poisoned = 1;
    /* This fixture never releases a gate. An early exit poisons the phase. */
    close(gate[1]);
    if (pidfd < 0) poisoned = 1;
    if (poisoned) {
        fault = 1;
        ownership_poison(ledger);
    }

    while (!drained) {
        if (!remaining_ms(&deadline) || ownership_is_poisoned(ledger)) {
            if (!cleaning) {
                cleaning = 1;
                ownership_poison(ledger);
                if (ownership_snapshot(ledger, record, &receipt) < 0) break;
                if (!receipt.has_status) {
                    interrupted = 1;
                    if (pidfd >= 0) (void)syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0);
                    else (void)kill(child, SIGKILL);
                }
                if (clock_gettime(CLOCK_MONOTONIC, &deadline) < 0) break;
                deadline.tv_sec += DEADLINE_SECONDS;
            } else if (!remaining_ms(&deadline)) break;
        }
        /* Every possible status has a reserved unknown-evidence slot. */
        if (ownership_unknown_count(ledger) >= UNKNOWN_CAPACITY) {
            fault = 1;
            ownership_poison(ledger);
            if (!cleaning) continue;
            break;
        }
        result = waitpid(-1, &status, WNOHANG | __WALL);
        if (result > 0) {
            if (ownership_observe_status(ledger, result, status) < 0) break;
            continue;
        }
        if (result < 0) {
            if (errno == EINTR) continue;
            if (errno == ECHILD) {
                (void)ownership_observe_echild(ledger);
                drained = 1;
                break;
            }
            fault = 1;
            ownership_poison(ledger);
            if (!cleaning) continue;
        } else {
            (void)ownership_observe_no_ready(ledger);
        }
        {
            int ready = poll(&event, 1, remaining_ms(&deadline));
            if (ready < 0 && errno != EINTR) {
                fault = 1;
                ownership_poison(ledger);
            }
            if (ready > 0) {
                struct signalfd_siginfo info;
                ssize_t bytes;
                if (event.revents & (POLLERR | POLLHUP | POLLNVAL)) {
                    fault = 1;
                    ownership_poison(ledger);
                }
                while ((bytes = read(event.fd, &info, sizeof(info))) == (ssize_t)sizeof(info)) {
                    if (info.ssi_signo != SIGCHLD) {
                        interrupted = 1;
                        ownership_poison(ledger);
                    }
                }
                if (bytes >= 0 || (errno != EAGAIN && errno != EINTR)) {
                    fault = 1;
                    ownership_poison(ledger);
                }
            }
        }
    }
    if (!drained) ownership_poison(ledger);
    if (ownership_snapshot(ledger, record, &receipt) < 0) return 2;
    /* A missing receipt or cleanup timeout is not successful teardown. */
    if (!receipt.has_status) ownership_poison(ledger);
    if (pidfd >= 0) close(pidfd);
    close(event.fd);
    printf("child_status=%d poison=%d drained=%d\n", receipt.has_status,
           ownership_is_poisoned(ledger), drained);
    return receipt.has_status && WIFEXITED(receipt.status) &&
           WEXITSTATUS(receipt.status) == 0 && drained &&
           ownership_is_poisoned(ledger) && !interrupted && !fault ? 0 : 1;
}
