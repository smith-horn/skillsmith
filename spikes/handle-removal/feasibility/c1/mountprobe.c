// SMI-6676 feasibility check 5 (Linux only, throwaway privileged container): can a handle-relative walk
// see a same-filesystem bind mount that st_dev misses, and does a held dir fd pin the underlying directory?
#define _GNU_SOURCE
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <linux/openat2.h>
#include <linux/stat.h>

static int op2(int dfd, const char *name) {
  struct open_how how = { .flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
                          .resolve = RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH };
  long fd = syscall(SYS_openat2, dfd, name, &how, sizeof how);
  if (fd < 0) return -errno;
  close((int)fd); return 0;
}
static void probe(const char *label, const char *parent, const char *child) {
  int pfd = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct statx ps, cs; struct stat pst, cst;
  statx(pfd, "", AT_EMPTY_PATH, STATX_BASIC_STATS | STATX_MNT_ID, &ps);
  statx(pfd, child, AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS | STATX_MNT_ID, &cs);
  fstat(pfd, &pst); fstatat(pfd, child, &cst, AT_SYMLINK_NOFOLLOW);
  int r2 = op2(pfd, child);
  printf("%s: st_dev_equal=%d mnt_id_supported=%d mnt_id_equal=%d child_MOUNT_ROOT_attr=%d openat2_NO_XDEV=%s\n", label,
         pst.st_dev == cst.st_dev, !!(cs.stx_mask & STATX_MNT_ID), ps.stx_mnt_id == cs.stx_mnt_id,
         !!(cs.stx_attributes & cs.stx_attributes_mask & STATX_ATTR_MOUNT_ROOT), r2 == 0 ? "ok" : strerror(-r2));
  close(pfd);
}
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (!strcmp(argv[1], "probe")) { probe(argv[2], argv[3], argv[4]); return 0; }
  if (!strcmp(argv[1], "pin")) {
    // argv[2]=parent argv[3]=child: open child fd, wait for a mount to be made over it, then unlinkat through the fd
    int pfd = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int cfd = openat(pfd, argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    printf("opened child fd=%d; waiting for mount\n", cfd); fflush(stdout); sleep(2);
    int r1 = unlinkat(cfd, "u.txt", 0); int e1 = errno;
    int r2 = unlinkat(pfd, argv[3], AT_REMOVEDIR); int e2 = errno;
    printf("unlinkat(childfd,u.txt)=%s rmdir(child via parentfd)=%s\n", r1 == 0 ? "ok" : strerror(e1), r2 == 0 ? "ok" : strerror(e2));
    return 0;
  }
  if (!strcmp(argv[1], "rename")) {
    int dfd = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int r = renameat2(dfd, argv[3], dfd, argv[4], RENAME_NOREPLACE);
    printf("renameat2 RENAME_NOREPLACE onto existing: %s\n", r == 0 ? "ok (REPLACED!)" : strerror(errno));
    return 0;
  }
  return 2;
}
