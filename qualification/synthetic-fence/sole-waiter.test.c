/* Synthetic syscall responses only: never forks, waits for, or signals a process. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <sys/signalfd.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

enum scenario { NORMAL, NO_CHILD, WAIT_ERROR, POLL_ERROR, READ_ERROR, SHORT_READ,
                INTERRUPT, FULL, TIMEOUT, NO_PIDFD, UNKNOWN, LATE_INTERRUPT,
                SIGNAL_FLOOD, SIGNAL_FAILURE };
static enum scenario scenario;
static int waits, signals_sent, polls, ticks, reads;

static int fake_sigaction(int sig, const struct sigaction *a, struct sigaction *old) {
    (void)sig; (void)a; (void)old; return 0;
}
static int fake_sigprocmask(int how, const sigset_t *set, sigset_t *old) {
    (void)how; (void)set; (void)old; return 0;
}
static int fake_signalfd(int fd, const sigset_t *mask, int flags) {
    (void)fd; (void)mask; (void)flags; return 10;
}
static int fake_clock_gettime(clockid_t id, struct timespec *t) {
    (void)id; t->tv_sec = ticks++ / 10; t->tv_nsec = 0; return 0;
}
static int fake_pipe2(int fds[2], int flags) {
    (void)flags; fds[0] = 11; fds[1] = 12; return 0;
}
static pid_t fake_fork(void) { return 42; }
static int fake_close(int fd) { (void)fd; return 0; }
static long fake_syscall(long number, ...) {
    if (number == SYS_pidfd_open) {
        if (scenario == NO_PIDFD) { errno = ENOSYS; return -1; }
        return 13;
    }
    assert(number == SYS_pidfd_send_signal);
    ++signals_sent;
    if (scenario == SIGNAL_FAILURE) { errno = EPERM; return -1; }
    return 0;
}
static int fake_kill(pid_t pid, int sig) {
    assert(pid == 42 && sig == SIGKILL); ++signals_sent; return 0;
}
static pid_t fake_waitpid(pid_t pid, int *status, int options) {
    (void)options; assert(pid == -1); ++waits;
    if (scenario == FULL) { *status = 0; return 100 + waits; }
    if (scenario == UNKNOWN && waits == 1) { *status = 0; return 99; }
    if (scenario == TIMEOUT || scenario == SIGNAL_FAILURE) return 0;
    if (scenario == NO_CHILD) { errno = ECHILD; return -1; }
    if (scenario == WAIT_ERROR && waits == 1) { errno = EIO; return -1; }
    if ((scenario == POLL_ERROR || scenario == READ_ERROR || scenario == SHORT_READ ||
         scenario == INTERRUPT) && waits == 1) return 0;
    if ((scenario == NORMAL || scenario == NO_PIDFD || scenario == LATE_INTERRUPT ||
         scenario == SIGNAL_FLOOD) ? waits == 1 : waits == 2) {
        *status = 0; return 42;
    }
    errno = ECHILD; return -1;
}
static int fake_poll(struct pollfd *fds, nfds_t n, int timeout) {
    (void)timeout; assert(n == 1); ++polls;
    if (scenario == POLL_ERROR && polls == 1) { errno = EIO; return -1; }
    if ((scenario == READ_ERROR || scenario == SHORT_READ || scenario == INTERRUPT) && polls == 1) {
        fds->revents = POLLIN; return 1;
    }
    return 0;
}
static ssize_t fake_read(int fd, void *buf, size_t count) {
    (void)fd; (void)count; ++reads;
    if (scenario == SHORT_READ && reads == 1) return 1;
    if (scenario == READ_ERROR && reads == 1) { errno = EIO; return -1; }
    if (scenario == SIGNAL_FLOOD ||
        ((scenario == INTERRUPT || scenario == LATE_INTERRUPT) && reads == 1)) {
        ((struct signalfd_siginfo *)buf)->ssi_signo = scenario == SIGNAL_FLOOD ? SIGCHLD : SIGTERM;
        return sizeof(struct signalfd_siginfo);
    }
    errno = EAGAIN;
    return -1;
}
#define sigaction(...) fake_sigaction(__VA_ARGS__)
#define sigprocmask fake_sigprocmask
#define signalfd fake_signalfd
#define clock_gettime fake_clock_gettime
#define pipe2 fake_pipe2
#define fork fake_fork
#define close fake_close
#define syscall fake_syscall
#define kill fake_kill
#define waitpid fake_waitpid
#define poll fake_poll
#define read fake_read
#define main supervisor_main
#include "sole-waiter.c"
#undef main

static void run(enum scenario next, int expected, int expected_waits, int expected_signals) {
    char *argv[] = {"synthetic", NULL};
    scenario = next; waits = signals_sent = polls = ticks = reads = 0; errno = 0;
    assert(supervisor_main(1, argv) == expected);
    if (expected_waits >= 0) assert(waits == expected_waits);
    assert(signals_sent == expected_signals);
}

int main(void) {
    run(NORMAL, 0, 2, 0);
    run(NO_CHILD, 1, 1, 0);
    run(WAIT_ERROR, 1, 3, 1);
    run(POLL_ERROR, 1, 3, 1);
    run(READ_ERROR, 1, 3, 1);
    run(SHORT_READ, 1, 3, 1);
    run(INTERRUPT, 1, 3, 1);
    run(FULL, 1, UNKNOWN_CAPACITY, 1);
    run(TIMEOUT, 1, -1, 1);
    run(NO_PIDFD, 1, 2, 1);
    run(UNKNOWN, 1, 3, 1);
    run(LATE_INTERRUPT, 1, 2, 0);
    run(SIGNAL_FLOOD, 1, 2, 0);
    assert(reads == SIGNAL_BATCH);
    run(SIGNAL_FAILURE, 1, -1, 1);
    return 0;
}
