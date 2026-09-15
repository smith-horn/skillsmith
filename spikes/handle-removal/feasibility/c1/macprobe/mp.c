// SMI-6676 check 5 (macOS): st_dev at a disk-image mount, fd pinning across a later mount, RENAME_EXCL, O_NOFOLLOW_ANY.
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <stdio.h>
int main(int argc, char **argv) {
  const char *mode = argv[1];
  if (!strcmp(mode, "dev")) { int p = open(argv[2], O_RDONLY|O_DIRECTORY|O_NOFOLLOW); struct stat a, b; fstat(p, &a); int r = fstatat(p, argv[3], &b, AT_SYMLINK_NOFOLLOW);
    int c = openat(p, argv[3], O_RDONLY|O_DIRECTORY|O_NOFOLLOW); struct stat cs; fstat(c, &cs); struct statfs sf; fstatfs(c, &sf);
    printf("dev: fstatat_dev_differs=%d opened_fd_dev_differs=%d fstatfs_mntonname=%s\n", r == 0 && a.st_dev != b.st_dev, a.st_dev != cs.st_dev, sf.f_mntonname); return 0; }
  if (!strcmp(mode, "pin")) { int p = open(argv[2], O_RDONLY|O_DIRECTORY|O_NOFOLLOW); int c = openat(p, argv[3], O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
    printf("pin: opened child fd=%d\n", c); fflush(stdout); sleep(4);
    int r1 = unlinkat(c, "u.txt", 0); int e1 = errno; int r2 = unlinkat(p, argv[3], AT_REMOVEDIR); int e2 = errno;
    printf("pin: unlinkat(childfd,u.txt)=%s rmdir(child via parentfd)=%s\n", r1 ? strerror(e1) : "ok", r2 ? strerror(e2) : "ok"); return 0; }
  if (!strcmp(mode, "rename")) { int d = open(argv[2], O_RDONLY|O_DIRECTORY); int r = renameatx_np(d, argv[3], d, argv[4], RENAME_EXCL); printf("renameatx_np RENAME_EXCL onto existing: %s\n", r ? strerror(errno) : "ok (REPLACED!)"); return 0; }
  if (!strcmp(mode, "nofollowany")) { int fd = open(argv[2], O_RDONLY|O_NOFOLLOW_ANY); printf("O_NOFOLLOW_ANY through a symlinked parent: %s\n", fd < 0 ? strerror(errno) : "opened"); return 0; }
  return 2; }
