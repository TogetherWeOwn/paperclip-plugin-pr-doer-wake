/* Inert filesystem tests only. Build with -Wl,--wrap=getrandom. */
#define _GNU_SOURCE
#include "phase-state.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned char seed;
ssize_t __wrap_getrandom(void *buf, size_t len, unsigned int flags)
{
    (void)flags;
    memset(buf, seed, len);
    return (ssize_t)len;
}

int main(void)
{
    char root[] = "/tmp/phase-state-test-XXXXXX", marker[42], old[40];
    struct phase_state a, b;
    struct stat st;
    int rootfd, cp, cg, f;
    assert(mkdtemp(root));
    rootfd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    assert(rootfd >= 0);
    assert(mkdirat(rootfd, "control", 0700) == 0);
    assert(mkdirat(rootfd, "cgroup", 0700) == 0);
    cp = openat(rootfd, "control", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    cg = openat(rootfd, "cgroup", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    assert(cp >= 0 && cg >= 0);

    /* A restrictive process umask must not strand an inaccessible directory. */
    mode_t previous_mask = umask(0777);
    int result = phase_state_allocate(&a, cp, cg);
    umask(previous_mask);
    assert(result == -1 && errno == EPERM && a.owned == 0);
    phase_state_close(&a);

    seed = 1;
    assert(phase_state_allocate(&a, cp, cg) == 0);
    assert(strlen(a.id) == 32 && fstat(a.control, &st) == 0 &&
           (st.st_mode & 0777) == 0700);
    assert(fstat(a.cli, &st) == 0 && fstat(a.workload, &st) == 0);
    assert(phase_state_allocate(&b, cp, cg) == -1 && errno == EEXIST);
    assert(b.owned == 0);
    phase_state_close(&b);
    /* Even an empty control directory survives failed cgroup cleanup. */
    f = openat(a.cli, "blocker", O_CREAT | O_EXCL | O_WRONLY, 0600);
    assert(f >= 0); close(f);
    assert(phase_state_cleanup(&a) == -1 && errno == ENOTEMPTY);
    assert(fstatat(cp, a.id, &st, AT_SYMLINK_NOFOLLOW) == 0);
    assert(a.control >= 0);
    assert(unlinkat(a.cli, "blocker", 0) == 0);
    f = openat(a.control, "unexpected", O_CREAT | O_EXCL | O_WRONLY, 0600);
    assert(f >= 0); close(f);
    assert(phase_state_cleanup(&a) == -1 && errno == ENOTEMPTY);
    assert(unlinkat(a.control, "unexpected", 0) == 0);
    assert(phase_state_cleanup(&a) == 0);
    snprintf(marker, sizeof(marker), "%s.reserve", a.id);
    assert(fstatat(cp, marker, &st, AT_SYMLINK_NOFOLLOW) == 0);
    phase_state_close(&a);
    assert(phase_state_allocate(&b, cp, cg) == -1 && errno == EEXIST);
    phase_state_close(&b);

    /* A pre-existing cgroup is never adopted or removed on partial failure. */
    seed = 3;
    memset(old, '0', 32);
    for (int i = 1; i < 32; i += 2) old[i] = '3';
    old[32] = '\0';
    assert(mkdirat(cg, old, 0700) == 0);
    assert(phase_state_allocate(&a, cp, cg) == -1 && errno == EEXIST);
    assert(phase_state_cleanup(&a) == 0);
    assert(fstatat(cg, old, &st, AT_SYMLINK_NOFOLLOW) == 0);
    snprintf(marker, sizeof(marker), "%s.reserve", a.id);
    phase_state_close(&a);
    assert(unlinkat(cg, old, AT_REMOVEDIR) == 0);
    assert(unlinkat(cp, marker, 0) == 0);

    seed = 2;
    assert(phase_state_allocate(&a, cp, -1) == 0);
    snprintf(old, sizeof(old), "%s.old", a.id);
    assert(renameat(cp, a.id, cp, old) == 0);
    assert(mkdirat(cp, a.id, 0700) == 0);
    assert(phase_state_cleanup(&a) == -1 && errno == ESTALE);
    assert(fstatat(cp, a.id, &st, AT_SYMLINK_NOFOLLOW) == 0);
    assert(unlinkat(cp, a.id, AT_REMOVEDIR) == 0);
    assert(renameat(cp, old, cp, a.id) == 0);
    assert(phase_state_cleanup(&a) == 0);
    snprintf(marker, sizeof(marker), "%s.reserve", a.id);
    phase_state_close(&a);
    assert(unlinkat(cp, marker, 0) == 0); /* Test-only ephemeral parent. */
    seed = 1;
    memset(marker, 0, sizeof(marker));
    for (int i = 0; i < 32; i += 2) { marker[i] = '0'; marker[i+1] = '1'; }
    memcpy(marker + 32, ".reserve", 9);
    assert(unlinkat(cp, marker, 0) == 0);
    assert(fchmod(cp, 0750) == 0);
    assert(phase_state_allocate(&a, cp, -1) == -1 && errno == EPERM);
    phase_state_close(&a);
    close(cp); close(cg);
    assert(unlinkat(rootfd, "control", AT_REMOVEDIR) == 0);
    assert(unlinkat(rootfd, "cgroup", AT_REMOVEDIR) == 0);
    close(rootfd);
    assert(rmdir(root) == 0);
    puts("phase-state inert tests passed");
    return 0;
}
