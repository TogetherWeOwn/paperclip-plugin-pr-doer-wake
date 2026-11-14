#define _GNU_SOURCE
#include "gated-launch.h"

#include <assert.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

struct observation { const char *marker; int fail; int called; };

static int record(const struct sf_child *child, void *arg)
{
    struct observation *o = arg;
    struct pollfd p = { .fd = child->pidfd, .events = POLLIN };
    assert(child->pid > 0 && child->pidfd >= 0 && child->poisoned);
    assert(access(o->marker, F_OK) == -1);
    assert(poll(&p, 1, 0) == 0);
    o->called++;
    return o->fail;
}

static struct timespec deadline(void)
{
    struct timespec t;
    assert(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
    t.tv_sec += 10;
    return t;
}

int main(int argc, char **argv)
{
    if (argc == 4 && strcmp(argv[1], "fixture") == 0) {
        char expected[4096], actual[4096];
        int fd = open("/proc/self/cgroup", O_RDONLY | O_CLOEXEC);
        if (fd < 0) return 2;
        ssize_t n = read(fd, actual, sizeof(actual) - 1);
        close(fd);
        if (n <= 0) return 3;
        actual[n] = '\0';
        int len = snprintf(expected, sizeof(expected), "0::/%s\n", strrchr(argv[3], '/') + 1);
        if (len < 0 || (size_t)len >= sizeof(expected) || strcmp(actual, expected) != 0) return 4;
        fd = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (fd < 0) return 5;
        close(fd);
        for (int i = 0; i < 1000; i++) {
            if (access(argv[2], F_OK) != 0) return 0;
            usleep(10000);
        }
        return 6;
    }
    assert(argc == 3 && getpid() == 1);
    sigset_t mask;
    assert(sigemptyset(&mask) == 0 && sigaddset(&mask, SIGCHLD) == 0);
    assert(sigprocmask(SIG_BLOCK, &mask, NULL) == 0);
    int dir = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int exe = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
    assert(dir >= 0 && exe >= 3);
    char *args[] = { "fixture", "fixture", argv[2], argv[1], NULL };
    char *env[] = { NULL };
    struct sf_child child;
    struct observation o = { .marker = argv[2], .fail = 1 };
    struct timespec end = deadline();
    assert(sf_gated_launch(&child, dir, exe, args, env, &end, record, &o) == -1);
    assert(o.called == 1 && child.poisoned && child.reaped && child.pid == 0 && child.pidfd == -1);
    assert(access(argv[2], F_OK) == -1);
    assert(waitpid(-1, NULL, WNOHANG) == -1);

    o.fail = 0; o.called = 0; end = deadline();
    assert(sf_gated_launch(&child, dir, exe, args, env, &end, record, &o) == 0);
    assert(o.called == 1 && !child.poisoned && child.pid > 0 && child.pidfd >= 0);
    int procs = openat(dir, "cgroup.procs", O_RDONLY | O_CLOEXEC);
    char buf[4096];
    assert(procs >= 0);
    ssize_t n = read(procs, buf, sizeof(buf));
    assert(n >= 0 && sf_cgroup_contains(buf, (size_t)n, child.pid) == 1);
    close(procs);
    for (int i = 0; i < 1000 && access(argv[2], F_OK) != 0; i++) usleep(10000);
    assert(access(argv[2], F_OK) == 0);
    assert(unlink(argv[2]) == 0);
    int status;
    assert(waitpid(child.pid, &status, 0) == child.pid);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    assert(waitpid(-1, NULL, WNOHANG) == -1);
    close(child.pidfd);
    close(exe);
    close(dir);
    puts("gated launch: callback refusal reaped; kernel placement and release observed");
    return 0;
}
