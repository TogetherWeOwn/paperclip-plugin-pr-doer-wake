#define _GNU_SOURCE
#include "gated-launch.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/magic.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define MEMBERSHIP_LIMIT 65536

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

static int before(const struct timespec *end)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return 0;
    return now.tv_sec < end->tv_sec ||
        (now.tv_sec == end->tv_sec && now.tv_nsec < end->tv_nsec);
}

/* close_range failures are fatal: never exec with unknown inherited fds. */
static void stub(int gate, int exe, char *const argv[], char *const envp[])
{
    int a = gate < exe ? gate : exe, b = gate < exe ? exe : gate;
    char token;
    ssize_t n;
    if (syscall(SYS_close_range, 0U, (unsigned)a - 1, 0U) < 0 ||
        (b > a + 1 && syscall(SYS_close_range, (unsigned)a + 1, (unsigned)b - 1, 0U) < 0) ||
        syscall(SYS_close_range, (unsigned)b + 1, UINT_MAX, 0U) < 0) _exit(126);
    do { n = read(gate, &token, 1); } while (n < 0 && errno == EINTR);
    if (n != 1 || token != 'G') _exit(125);
    close(gate);
    {
        struct sigaction sa = {0};
        sigset_t empty;
        sa.sa_handler = SIG_DFL;
        if (sigemptyset(&sa.sa_mask) < 0 || sigaction(SIGCHLD, &sa, NULL) < 0 ||
            sigemptyset(&empty) < 0 || sigprocmask(SIG_SETMASK, &empty, NULL) < 0) _exit(126);
    }
    syscall(SYS_execveat, exe, "", argv, envp, AT_EMPTY_PATH);
    _exit(127);
}

static int membership(int dirfd, pid_t pid)
{
    char buf[MEMBERSHIP_LIMIT + 1];
    size_t used = 0;
    int fd = openat(dirfd, "cgroup.procs", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    while (used < sizeof(buf)) {
        ssize_t n = read(fd, buf + used, sizeof(buf) - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { close(fd); return -1; }
        if (!n) break;
        used += (size_t)n;
    }
    close(fd);
    if (used > MEMBERSHIP_LIMIT) { errno = EOVERFLOW; return -1; }
    return sf_cgroup_contains(buf, used, pid);
}

static void terminate_owned(struct sf_child *c, const struct timespec *deadline)
{
    int status;
    /* The child is still unreaped and therefore its numeric PID cannot recycle. */
    if (c->pidfd >= 0) (void)syscall(SYS_pidfd_send_signal, c->pidfd, SIGKILL, NULL, 0);
    else (void)kill(c->pid, SIGKILL);
    while (before(deadline)) {
        pid_t r = waitpid(c->pid, &status, WNOHANG | __WALL);
        if (r == c->pid) {
            c->wait_status = status; c->reaped = 1; c->pid = 0;
            if (c->pidfd >= 0) { close(c->pidfd); c->pidfd = -1; }
            return;
        }
        if (r < 0 && errno != EINTR) return; /* ECHILD is not a receipt */
        if (r == 0) {
            struct timespec pause = {0, 1000000};
            (void)nanosleep(&pause, NULL);
        }
    }
}

int sf_gated_launch(struct sf_child *c, int dirfd, int exe, char *const argv[],
                    char *const envp[], const struct timespec *deadline,
                    int (*record_child)(const struct sf_child *, void *), void *context)
{
    int gate[2] = {-1, -1}, fd = -1, saved = EINVAL;
    struct statfs fs;
    struct sigaction disposition;
    sigset_t mask;
    char pidbuf[32];
    int len, exe_flags;
    struct pollfd pfd;
    if (!c) { errno = EINVAL; return -1; }
    memset(c, 0, sizeof(*c)); c->pidfd = -1; c->poisoned = 1;
    if (!deadline || deadline->tv_nsec < 0 || deadline->tv_nsec >= 1000000000L ||
        !record_child || !argv || !argv[0] || !envp || exe < 3 || dirfd < 0 ||
        (exe_flags = fcntl(exe, F_GETFD)) < 0 || !(exe_flags & FD_CLOEXEC) ||
        getpid() != 1 || sigaction(SIGCHLD, NULL, &disposition) < 0 ||
        disposition.sa_handler == SIG_IGN || (disposition.sa_flags & SA_NOCLDWAIT) ||
        sigprocmask(SIG_SETMASK, NULL, &mask) < 0 || sigismember(&mask, SIGCHLD) != 1 ||
        fstatfs(dirfd, &fs) < 0 || (unsigned long)fs.f_type != CGROUP2_SUPER_MAGIC ||
        !before(deadline)) { errno = EINVAL; return -1; }
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, gate) < 0) return -1;
    c->pid = fork();
    if (c->pid < 0) { c->pid = 0; saved = errno; goto fail; }
    if (c->pid == 0) { close(gate[0]); stub(gate[1], exe, argv, envp); }
    close(gate[1]); gate[1] = -1;
    c->pidfd = (int)syscall(SYS_pidfd_open, c->pid, 0);
    if (c->pidfd < 0) { saved = errno; goto fail; }
    if (!before(deadline) || record_child(c, context) != 0 || !before(deadline)) {
        saved = ETIMEDOUT; goto fail;
    }
    len = snprintf(pidbuf, sizeof(pidbuf), "%ld\n", (long)c->pid);
    if (len <= 0 || (size_t)len >= sizeof(pidbuf)) { saved = EOVERFLOW; goto fail; }
    fd = openat(dirfd, "cgroup.procs", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) { saved = errno; goto fail; }
    /* A short or interrupted write is uncertain, never retry a partial write. */
    if (write(fd, pidbuf, (size_t)len) != len) { saved = EIO; goto fail; }
    close(fd); fd = -1;
    if (!before(deadline) || membership(dirfd, c->pid) != 1 || !before(deadline)) {
        saved = EIO; goto fail;
    }
    pfd.fd = c->pidfd; pfd.events = POLLIN; pfd.revents = 0;
    if (poll(&pfd, 1, 0) != 0 || !before(deadline)) { saved = ECHILD; goto fail; }
    if (send(gate[0], "G", 1, MSG_NOSIGNAL) != 1) { saved = EPIPE; goto fail; }
    if (!before(deadline)) { saved = ETIMEDOUT; goto fail; }
    close(gate[0]);
    c->poisoned = 0;
    return 0;
fail:
    if (fd >= 0) close(fd);
    if (gate[0] >= 0) close(gate[0]);
    if (gate[1] >= 0) close(gate[1]);
    if (c->pid > 0) terminate_owned(c, deadline);
    errno = saved;
    return -1;
}
