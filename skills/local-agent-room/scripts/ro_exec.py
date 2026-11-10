#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ro_exec.py：用 Linux Landlock 让一条命令和它的全部子进程只能写指定的目录。

    ro_exec.py --allow-write DIR [--allow-write DIR ...] -- 命令 参数...
    ro_exec.py --probe        内核支持就退出 0，并打印 Landlock ABI 版本

为什么需要它：很多 HPC 登录节点关闭了 user namespace（max_user_namespaces=0），
Codex 自带的 bubblewrap 沙箱在那里起不来。Landlock 不需要 root，也不需要 user namespace，
限制由内核强制执行，命令自己和它启动的任何子进程都绕不过去。

限制范围：只拦“改动文件系统”的操作（写、建、删、改名、截断）。读、执行和联网不受限制。
内核需要 >= 5.13 并启用 landlock（cat /sys/kernel/security/lsm 里能看到）。只用标准库。
"""
import ctypes
import errno
import os
import stat
import sys

SYS_CREATE_RULESET, SYS_ADD_RULE, SYS_RESTRICT_SELF = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38
RULE_PATH_BENEATH = 1
WRITE_FILE, REFER, TRUNCATE = 1 << 1, 1 << 13, 1 << 14
# REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR, MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM
DIR_ONLY = sum(1 << b for b in range(4, 13))


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def _libc():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    return libc


def abi_version():
    """Landlock ABI 版本；不可用时返回 0。"""
    if not sys.platform.startswith("linux"):
        return 0
    try:
        v = _libc().syscall(ctypes.c_long(SYS_CREATE_RULESET), None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    except (OSError, AttributeError):
        return 0
    return int(v) if v > 0 else 0


def restrict_writes(allow):
    """从现在起，本进程和所有子进程只能在 allow 列出的路径下改动文件。不可撤销。"""
    libc = _libc()
    abi = abi_version()
    if abi < 1:
        raise OSError(errno.ENOSYS, "这台机器的内核不支持 Landlock")
    handled = WRITE_FILE | DIR_ONLY | (REFER if abi >= 2 else 0) | (TRUNCATE if abi >= 3 else 0)
    attr = RulesetAttr(handled)
    ruleset = libc.syscall(ctypes.c_long(SYS_CREATE_RULESET), ctypes.byref(attr),
                           ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0))
    if ruleset < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset 失败")
    try:
        for path in allow:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                is_dir = stat.S_ISDIR(os.fstat(fd).st_mode)
                rule = PathBeneath(handled if is_dir else handled & (WRITE_FILE | TRUNCATE), fd)
                if libc.syscall(ctypes.c_long(SYS_ADD_RULE), ctypes.c_int(ruleset), ctypes.c_int(RULE_PATH_BENEATH),
                                ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
                    raise OSError(ctypes.get_errno(), "landlock_add_rule 失败：%s" % path)
            finally:
                os.close(fd)
        if libc.prctl(ctypes.c_int(PR_SET_NO_NEW_PRIVS), ctypes.c_ulong(1), ctypes.c_ulong(0),
                      ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
            raise OSError(ctypes.get_errno(), "prctl(NO_NEW_PRIVS) 失败")
        if libc.syscall(ctypes.c_long(SYS_RESTRICT_SELF), ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:
            raise OSError(ctypes.get_errno(), "landlock_restrict_self 失败")
    finally:
        os.close(ruleset)


def main(argv):
    if argv == ["--probe"]:
        v = abi_version()
        print("Landlock ABI %d" % v if v else "Landlock 不可用")
        return 0 if v else 1
    allow = []
    while argv and argv[0] == "--allow-write":
        if len(argv) < 2:
            break
        allow.append(argv[1])
        argv = argv[2:]
    if not argv or argv[0] != "--" or len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        # 不存在的目录直接跳过：没有它就谈不上往里写
        restrict_writes([p for p in allow if os.path.exists(p)])
    except OSError as e:
        # 失败即拒绝：宁可不运行，也不在没有限制的情况下运行
        print("ro_exec：无法启用只读限制，命令没有执行：%s" % e, file=sys.stderr)
        return 126
    try:
        os.execvp(argv[1], argv[1:])
    except OSError as e:
        print("ro_exec：无法执行 %s：%s" % (argv[1], e), file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
