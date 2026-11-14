#define syscall test_syscall
#include "gated-launch.c"
#undef syscall
#include <assert.h>
static int signal_attempts;
static void handler(int sig) { (void)sig; }
long test_syscall(long number, ...)
{
    assert(number == SYS_pidfd_send_signal);
    signal_attempts++;
    errno = EPERM;
    return -1;
}
int main(void)
{
    int ready[2];
    char byte;
    struct timespec end;
    struct sf_child child = { .pidfd = -1, .poisoned = 1 };
    assert(signal(SIGUSR1, handler) != SIG_ERR);
    assert(!no_caught_signals());
    assert(signal(SIGUSR1, SIG_DFL) != SIG_ERR);
    assert(no_caught_signals());
    assert(pipe(ready) == 0);
    child.pid = fork();
    assert(child.pid >= 0);
    if (child.pid == 0) {
        close(ready[0]);
        alarm(8);
        if (write(ready[1], "R", 1) != 1) _exit(1);
        for (;;) pause();
    }
    close(ready[1]);
    assert(read(ready[0], &byte, 1) == 1 && byte == 'R');
    close(ready[0]);
    child.pidfd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    assert(child.pidfd >= 0);
    assert(clock_gettime(CLOCK_MONOTONIC, &end) == 0);
    end.tv_sec += 5;
    terminate_owned(&child, &end);
    assert(signal_attempts == 1 && child.reaped && child.pid == 0 && child.pidfd == -1);
    assert(WIFSIGNALED(child.wait_status) && WTERMSIG(child.wait_status) == SIGKILL);
    return 0;
}
