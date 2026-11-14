#define _GNU_SOURCE
#include "phase-state.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

enum { CONTROL = 1, CGROUP = 2, CLI = 4, WORKLOAD = 8 };

static int dup_dir(int fd, int private_dir)
{
    struct stat st;
    int copy = fcntl(fd, F_DUPFD_CLOEXEC, 3);
    if (copy < 0) return -1;
    if (fstat(copy, &st) < 0) {
        int e = errno; close(copy); errno = e; return -1;
    }
    if (!S_ISDIR(st.st_mode) || st.st_uid != geteuid() ||
        (private_dir && (st.st_mode & 07777) != 0700)) {
        close(copy); errno = EPERM; return -1;
    }
    return copy;
}

static int make_dir(int parent, const char *name, int *fd,
                    unsigned *owned, unsigned bit)
{
    if (mkdirat(parent, name, 0700) < 0) return -1;
    *owned |= bit; /* Record even if opening the newly created directory fails. */
    *fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    return *fd < 0 ? -1 : 0;
}

int phase_state_allocate(struct phase_state *s, int control_parent_fd,
                         int cgroup_parent_fd)
{
    unsigned char random[16];
    static const char hex[] = "0123456789abcdef";
    char reservation[42];
    size_t n = 0, i;
    int marker;
    if (!s) { errno = EINVAL; return -1; }
    memset(s, 0, sizeof(*s));
    s->control_parent = s->cgroup_parent = -1;
    s->control = s->cgroup = s->cli = s->workload = -1;
    if (cgroup_parent_fd < -1) { errno = EINVAL; return -1; }
    s->control_parent = dup_dir(control_parent_fd, 1);
    if (s->control_parent < 0) return -1;
    if (cgroup_parent_fd != -1) {
        s->cgroup_parent = dup_dir(cgroup_parent_fd, 0);
        if (s->cgroup_parent < 0) return -1;
    }
    while (n < sizeof(random)) {
        ssize_t r = getrandom(random + n, sizeof(random) - n, 0);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) { if (r == 0) errno = EIO; return -1; }
        n += (size_t)r;
    }
    for (i = 0; i < sizeof(random); ++i) {
        s->id[2*i] = hex[random[i] >> 4];
        s->id[2*i+1] = hex[random[i] & 15];
    }
    s->id[32] = '\0';
    (void)snprintf(reservation, sizeof(reservation), "%s.reserve", s->id);
    marker = openat(s->control_parent, reservation,
                    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (marker < 0) return -1;
    if (close(marker) < 0) return -1; /* Reservation is never removed. */
    if (make_dir(s->control_parent, s->id, &s->control, &s->owned, CONTROL) < 0)
        return -1;
    /* mkdir is affected by umask; set precisely private permissions. */
    if (fchmod(s->control, 0700) < 0) return -1;
    if (s->cgroup_parent < 0) return 0;
    if (make_dir(s->cgroup_parent, s->id, &s->cgroup, &s->owned, CGROUP) < 0 ||
        make_dir(s->cgroup, "cli", &s->cli, &s->owned, CLI) < 0 ||
        make_dir(s->cgroup, "workload", &s->workload, &s->owned, WORKLOAD) < 0)
        return -1;
    return 0;
}

static int remove_owned(int parent, const char *name, int *fd,
                        unsigned *owned, unsigned bit)
{
    struct stat held, current;
    if (!(*owned & bit)) return 0;
    if (parent < 0 || *fd < 0) { errno = ESTALE; return -1; }
    if (fstat(*fd, &held) < 0 ||
        fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) < 0) return -1;
    if (!S_ISDIR(current.st_mode) || held.st_dev != current.st_dev ||
        held.st_ino != current.st_ino) { errno = ESTALE; return -1; }
    if (unlinkat(parent, name, AT_REMOVEDIR) < 0) return -1;
    close(*fd); *fd = -1; *owned &= ~bit;
    return 0;
}

int phase_state_cleanup(struct phase_state *s)
{
    int error = 0;
    if (!s) { errno = EINVAL; return -1; }
#define REMOVE(parent, name, field, bit) \
    do { if (remove_owned((parent), (name), &s->field, &s->owned, (bit)) < 0 && !error) error = errno; } while (0)
    REMOVE(s->cgroup, "cli", cli, CLI);
    REMOVE(s->cgroup, "workload", workload, WORKLOAD);
    REMOVE(s->cgroup_parent, s->id, cgroup, CGROUP);
    /* Keep ownership records available while any cgroup cleanup is uncertain. */
    if (!error) REMOVE(s->control_parent, s->id, control, CONTROL);
#undef REMOVE
    if (error) { errno = error; return -1; }
    return 0;
}

void phase_state_close(struct phase_state *s)
{
    if (!s) return;
#define CLOSE(field) do { if (s->field >= 0) close(s->field); s->field = -1; } while (0)
    CLOSE(cli); CLOSE(workload); CLOSE(cgroup); CLOSE(control);
    CLOSE(cgroup_parent); CLOSE(control_parent);
#undef CLOSE
}
