"""Bridge byte streams to a real POSIX terminal; never log or persist input."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Missing terminal program")
    pid, master = pty.fork()
    if pid == 0:
        os.execv(sys.argv[1], sys.argv[1:])
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, stop)
    stdin = sys.stdin.fileno()
    inputs = [master, stdin]
    status = None
    try:
        while True:
            ready, _, _ = select.select(inputs, [], [], 0.25)
            if master in ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                os.write(sys.stdout.fileno(), chunk)
            if stdin in ready:
                chunk = os.read(stdin, 4096)
                if chunk:
                    os.write(master, chunk)
                else:
                    inputs.remove(stdin)
            ended, child_status = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = child_status
                # Drain bytes already queued by the child before returning.
                while select.select([master], [], [], 0)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    os.write(sys.stdout.fileno(), chunk)
                break
            if stopping:
                break
    finally:
        if stopping:
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        os.close(master)
    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(main())
