// SMI-6676 C1: the thin native shim, §4.1. N-API v8, plain C.
//
// Every exported function returns a JS object with an `errno` field: 0 on
// success, a negative errno-style value on failure ("returns -errno rather
// than throwing" per the plan -- the JS walk classifies every errno itself).
// This is a uniform envelope rather than the plan's per-function return-type
// table verbatim (a bare number for opens, a struct for stats): richer data
// needs an object regardless, so every function uses one, for one calling
// convention instead of two.
//
// dev/ino/mntId are returned as JS BigInt (napi_create_bigint_uint64) to
// match c0-walk.mjs's own bigint identity source -- a float here would be a
// weaker instrument than the mechanism being compared against.
//
// Linux vs macOS differ at exactly the points §4.1's table says they would:
// openAt tries openat2(RESOLVE_NO_XDEV|RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH)
// on Linux, falling back to openat(O_NOFOLLOW) + a statx mnt_id compare
// when openat2 is unavailable (ENOSYS/EPERM); macOS has neither syscall, so
// openAt is openat(O_NOFOLLOW) + an fstat st_dev compare against the parent,
// always. renameAtNoReplace is renameat2(RENAME_NOREPLACE) vs
// renameatx_np(RENAME_EXCL) -- confirmed working in
// spikes/handle-removal/feasibility/c1/{mountprobe.c,macprobe/mp.c}, whose
// exact header set and syscall usage this file reuses rather than
// re-deriving from memory.

#define NAPI_VERSION 8
#include <node_api.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <dirent.h>
#include <sys/stat.h>

#ifdef __linux__
#include <sys/syscall.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
// glibc 2.36 (node:22-slim) implements renameat2() but this container's
// <fcntl.h> does not prototype it even with _GNU_SOURCE defined (confirmed:
// it links and behaves correctly without this, just with an implicit-
// declaration warning) -- declared explicitly so the call is well-formed.
extern int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath,
                      unsigned int flags);
#endif

#ifdef __APPLE__
#include <stdio.h> // renameatx_np, RENAME_EXCL -- see feasibility/c1/macprobe/mp.c
#include <sys/mount.h>
#endif

#define PATH_BUF 4096
#define NAME_BUF 1024

// ---- small N-API helpers --------------------------------------------------

static napi_value new_obj(napi_env env) {
  napi_value o;
  napi_create_object(env, &o);
  return o;
}

static void set_i32(napi_env env, napi_value o, const char *k, int32_t v) {
  napi_value x;
  napi_create_int32(env, v, &x);
  napi_set_named_property(env, o, k, x);
}

static void set_bool(napi_env env, napi_value o, const char *k, int v) {
  napi_value x;
  napi_get_boolean(env, v ? true : false, &x);
  napi_set_named_property(env, o, k, x);
}

static void set_str(napi_env env, napi_value o, const char *k, const char *v) {
  napi_value x;
  napi_create_string_utf8(env, v, NAPI_AUTO_LENGTH, &x);
  napi_set_named_property(env, o, k, x);
}

static void set_u64(napi_env env, napi_value o, const char *k, uint64_t v) {
  napi_value x;
  napi_create_bigint_uint64(env, v, &x);
  napi_set_named_property(env, o, k, x);
}

// {errno} only
static napi_value err_result(napi_env env, int e) {
  napi_value o = new_obj(env);
  set_i32(env, o, "errno", e);
  return o;
}

static size_t get_str_arg(napi_env env, napi_value v, char *buf, size_t buflen) {
  size_t len = 0;
  buf[0] = '\0';
  napi_get_value_string_utf8(env, v, buf, buflen, &len);
  return len;
}

static int32_t get_i32_arg(napi_env env, napi_value v) {
  int32_t x = 0;
  napi_get_value_int32(env, v, &x);
  return x;
}

static const char *type_name(mode_t mode) {
  if (S_ISDIR(mode)) return "dir";
  if (S_ISLNK(mode)) return "symlink";
  if (S_ISREG(mode)) return "file";
  return "other";
}

// ---- capability probes -----------------------------------------------------

#ifdef __linux__
static int probe_openat2(void) {
  struct open_how how = { .flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, .resolve = 0 };
  long fd = syscall(SYS_openat2, AT_FDCWD, ".", &how, sizeof how);
  if (fd >= 0) {
    close((int)fd);
    return 1;
  }
  return errno != ENOSYS && errno != EPERM;
}

static int probe_mnt_id(void) {
  struct statx stx;
  memset(&stx, 0, sizeof stx);
  if (statx(AT_FDCWD, ".", 0, STATX_MNT_ID, &stx) != 0) return 0;
  return (stx.stx_mask & STATX_MNT_ID) != 0;
}
#endif

static int probe_rename_no_replace(void) {
  // A nonexistent source is safe (no side effect either way): ENOENT means
  // the syscall/flag exists and ran; ENOSYS means it does not.
#ifdef __linux__
  int r = renameat2(AT_FDCWD, "/nonexistent-smi6676-probe-src", AT_FDCWD,
                     "/nonexistent-smi6676-probe-dst", RENAME_NOREPLACE);
#else
  int r = renameatx_np(AT_FDCWD, "/nonexistent-smi6676-probe-src", AT_FDCWD,
                        "/nonexistent-smi6676-probe-dst", RENAME_EXCL);
#endif
  if (r == 0) return 1; // should not happen (source doesn't exist), but not ENOSYS either
  return errno != ENOSYS;
}

static napi_value Capabilities(napi_env env, napi_callback_info info) {
  napi_value o = new_obj(env);
#ifdef __linux__
  set_bool(env, o, "openat2", probe_openat2());
  set_bool(env, o, "mntId", probe_mnt_id());
#else
  set_bool(env, o, "openat2", 0);
  set_bool(env, o, "mntId", 0);
#endif
  set_bool(env, o, "renameNoReplace", probe_rename_no_replace());
  return o;
}

// ---- openDir(absPath) -------------------------------------------------------

static napi_value OpenDir(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char path[PATH_BUF];
  get_str_arg(env, argv[0], path, sizeof path);

  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  napi_value o = new_obj(env);
  set_i32(env, o, "errno", fd < 0 ? -errno : 0);
  set_i32(env, o, "fd", fd < 0 ? -1 : fd);
  return o;
}

// ---- openAt(dirFd, name, wantDir) -------------------------------------------

#ifdef __linux__
static int open_at_fallback_mnt_check(int dirFd, int fd) {
  // Compare mnt_id (preferred) or st_dev (fallback) between dirFd and fd.
  struct statx ps, cs;
  memset(&ps, 0, sizeof ps);
  memset(&cs, 0, sizeof cs);
  int have_mnt = statx(dirFd, "", AT_EMPTY_PATH, STATX_MNT_ID, &ps) == 0 &&
                 (ps.stx_mask & STATX_MNT_ID) &&
                 statx(fd, "", AT_EMPTY_PATH, STATX_MNT_ID, &cs) == 0 &&
                 (cs.stx_mask & STATX_MNT_ID);
  if (have_mnt) return ps.stx_mnt_id == cs.stx_mnt_id;
  struct stat pst, cst;
  if (fstat(dirFd, &pst) != 0 || fstat(fd, &cst) != 0) return 0; // can't prove sameness -> treat as boundary
  return pst.st_dev == cst.st_dev;
}
#endif

static napi_value OpenAt(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t dirFd = get_i32_arg(env, argv[0]);
  char name[NAME_BUF];
  get_str_arg(env, argv[1], name, sizeof name);
  bool wantDir;
  napi_get_value_bool(env, argv[2], &wantDir);

  int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (wantDir ? O_DIRECTORY : 0);

#ifdef __linux__
  struct open_how how = {
    .flags = flags,
    .resolve = RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH,
  };
  long fd = syscall(SYS_openat2, dirFd, name, &how, sizeof how);
  if (fd >= 0 || (errno != ENOSYS && errno != EPERM)) {
    napi_value o = new_obj(env);
    set_i32(env, o, "errno", fd < 0 ? -errno : 0);
    set_i32(env, o, "fd", fd < 0 ? -1 : (int32_t)fd);
    return o;
  }
  // openat2 unsupported here (ENOSYS/EPERM) -- fall back.
  int f = openat(dirFd, name, flags);
  if (f < 0) return err_result(env, -errno);
  if (!open_at_fallback_mnt_check(dirFd, f)) {
    close(f);
    napi_value o = new_obj(env);
    set_i32(env, o, "errno", -EXDEV);
    set_i32(env, o, "fd", -1);
    return o;
  }
  napi_value o = new_obj(env);
  set_i32(env, o, "errno", 0);
  set_i32(env, o, "fd", f);
  return o;
#else
  int f = openat(dirFd, name, flags);
  if (f < 0) return err_result(env, -errno);
  struct stat pst, cst;
  if (fstat(dirFd, &pst) != 0 || fstat(f, &cst) != 0 || pst.st_dev != cst.st_dev) {
    close(f);
    napi_value o = new_obj(env);
    set_i32(env, o, "errno", -EXDEV);
    set_i32(env, o, "fd", -1);
    return o;
  }
  napi_value o = new_obj(env);
  set_i32(env, o, "errno", 0);
  set_i32(env, o, "fd", f);
  return o;
#endif
}

// ---- statAt(dirFd, name) ----------------------------------------------------

static napi_value StatAt(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t dirFd = get_i32_arg(env, argv[0]);
  char name[NAME_BUF];
  get_str_arg(env, argv[1], name, sizeof name);

  struct stat st;
  if (fstatat(dirFd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    return err_result(env, -errno);
  }
  napi_value o = new_obj(env);
  set_i32(env, o, "errno", 0);
  set_str(env, o, "type", type_name(st.st_mode));
  set_u64(env, o, "dev", (uint64_t)st.st_dev);
  set_u64(env, o, "ino", (uint64_t)st.st_ino);
  set_i32(env, o, "mode", (int32_t)st.st_mode);
  set_u64(env, o, "size", (uint64_t)st.st_size);

#ifdef __linux__
  struct statx stx;
  memset(&stx, 0, sizeof stx);
  if (statx(dirFd, name, AT_SYMLINK_NOFOLLOW, STATX_MNT_ID, &stx) == 0 &&
      (stx.stx_mask & STATX_MNT_ID)) {
    set_u64(env, o, "mntId", stx.stx_mnt_id);
  }
#endif
  return o;
}

// ---- readdirFd(dirFd) -------------------------------------------------------

static napi_value ReaddirFd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t dirFd = get_i32_arg(env, argv[0]);

  // NOT dup(dirFd): a dup'd fd shares the underlying open file description
  // -- including the directory read position -- with the original, so a
  // second readdirFd() call on the same dirFd would see nothing left after
  // the first one ran to EOF (confirmed empirically; see the checkpoint-2
  // report). openat(dirFd, ".") gives a genuinely independent open file
  // description over the same directory, with its own read position, so
  // repeated calls -- the guard pass and, later, the removal pass's re-list
  // -- each start from the beginning.
  int freshFd = openat(dirFd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (freshFd < 0) return err_result(env, -errno);
  DIR *d = fdopendir(freshFd);
  if (!d) {
    int e = errno;
    close(freshFd);
    return err_result(env, -e);
  }

  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t idx = 0;
  struct dirent *de;
  errno = 0;
  while ((de = readdir(d)) != NULL) {
    if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
    napi_value entry = new_obj(env);
    set_str(env, entry, "name", de->d_name);
    const char *t = "unknown";
#ifdef DT_DIR
    switch (de->d_type) {
      case DT_DIR: t = "dir"; break;
      case DT_REG: t = "file"; break;
      case DT_LNK: t = "symlink"; break;
      default: t = "unknown"; break;
    }
#endif
    set_str(env, entry, "type", t);
    napi_set_element(env, arr, idx++, entry);
    errno = 0;
  }
  int saved = errno;
  closedir(d); // also closes freshFd
  if (saved != 0) return err_result(env, -saved);

  napi_value o = new_obj(env);
  set_i32(env, o, "errno", 0);
  napi_set_named_property(env, o, "entries", arr);
  return o;
}

// ---- readlinkAt(dirFd, name) ------------------------------------------------

static napi_value ReadlinkAt(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t dirFd = get_i32_arg(env, argv[0]);
  char name[NAME_BUF];
  get_str_arg(env, argv[1], name, sizeof name);

  char target[PATH_BUF];
  ssize_t n = readlinkat(dirFd, name, target, sizeof target - 1);
  if (n < 0) return err_result(env, -errno);
  target[n] = '\0';
  napi_value o = new_obj(env);
  set_i32(env, o, "errno", 0);
  set_str(env, o, "target", target);
  return o;
}

// ---- unlinkAt(dirFd, name, isDir) -------------------------------------------

static napi_value UnlinkAt(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t dirFd = get_i32_arg(env, argv[0]);
  char name[NAME_BUF];
  get_str_arg(env, argv[1], name, sizeof name);
  bool isDir;
  napi_get_value_bool(env, argv[2], &isDir);

  int r = unlinkat(dirFd, name, isDir ? AT_REMOVEDIR : 0);
  return err_result(env, r == 0 ? 0 : -errno);
}

// ---- renameAtNoReplace(fromFd, fromName, toFd, toName) ---------------------

static napi_value RenameAtNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fromFd = get_i32_arg(env, argv[0]);
  char fromName[NAME_BUF];
  get_str_arg(env, argv[1], fromName, sizeof fromName);
  int32_t toFd = get_i32_arg(env, argv[2]);
  char toName[NAME_BUF];
  get_str_arg(env, argv[3], toName, sizeof toName);

#ifdef __linux__
  int r = renameat2(fromFd, fromName, toFd, toName, RENAME_NOREPLACE);
#else
  int r = renameatx_np(fromFd, fromName, toFd, toName, RENAME_EXCL);
#endif
  return err_result(env, r == 0 ? 0 : -errno);
}

// ---- mkdirAt(dirFd, name, mode) ---------------------------------------------

static napi_value MkdirAt(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t dirFd = get_i32_arg(env, argv[0]);
  char name[NAME_BUF];
  get_str_arg(env, argv[1], name, sizeof name);
  int32_t mode = get_i32_arg(env, argv[2]);

  int r = mkdirat(dirFd, name, (mode_t)mode);
  return err_result(env, r == 0 ? 0 : -errno);
}

// ---- closeFd(fd) -------------------------------------------------------------

static napi_value CloseFd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = get_i32_arg(env, argv[0]);
  int r = close(fd);
  return err_result(env, r == 0 ? 0 : -errno);
}

// ---- module init --------------------------------------------------------------

static void export_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value f;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &f);
  napi_set_named_property(env, exports, name, f);
}

NAPI_MODULE_INIT() {
  export_fn(env, exports, "capabilities", Capabilities);
  export_fn(env, exports, "openDir", OpenDir);
  export_fn(env, exports, "openAt", OpenAt);
  export_fn(env, exports, "statAt", StatAt);
  export_fn(env, exports, "readdirFd", ReaddirFd);
  export_fn(env, exports, "readlinkAt", ReadlinkAt);
  export_fn(env, exports, "unlinkAt", UnlinkAt);
  export_fn(env, exports, "renameAtNoReplace", RenameAtNoReplace);
  export_fn(env, exports, "mkdirAt", MkdirAt);
  export_fn(env, exports, "closeFd", CloseFd);
  return exports;
}
