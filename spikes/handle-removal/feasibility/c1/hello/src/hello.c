#define NAPI_VERSION 8
#include <node_api.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
/* hello(): returns 42; probe_openat(dir, name): openat(AT_FDCWD dir, O_DIRECTORY|O_NOFOLLOW) then openat(dirfd, name, O_NOFOLLOW) -> errno or fd>=0 (closed) */
static napi_value Hello(napi_env env, napi_callback_info info) { napi_value r; napi_create_int32(env, 42, &r); return r; }
static napi_value ProbeOpenat(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char dir[4096], name[256]; size_t l;
  napi_get_value_string_utf8(env, argv[0], dir, sizeof dir, &l); napi_get_value_string_utf8(env, argv[1], name, sizeof name, &l);
  int dfd = open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); int rv;
  if (dfd < 0) rv = -errno; else { int fd = openat(dfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); rv = fd < 0 ? -errno : 0; if (fd >= 0) close(fd); close(dfd); }
  napi_value r; napi_create_int32(env, rv, &r); return r; }
NAPI_MODULE_INIT() {
  napi_value f1, f2; napi_create_function(env, "hello", NAPI_AUTO_LENGTH, Hello, NULL, &f1); napi_set_named_property(env, exports, "hello", f1);
  napi_create_function(env, "probeOpenat", NAPI_AUTO_LENGTH, ProbeOpenat, NULL, &f2); napi_set_named_property(env, exports, "probeOpenat", f2);
  return exports; }
