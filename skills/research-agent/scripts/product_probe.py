"""Stream a product probe in its workspace while keeping local and chair copies."""
from pathlib import Path
import subprocess
import sys


def resolve_outdir(workspace, relative):
    root = workspace.resolve(strict=True)
    target = (root / relative).resolve()
    if relative.is_absolute() or ".." in relative.parts or (target != root and root not in target.parents):
        raise ValueError("--outdir must stay inside the workspace")
    return target


def run(workspace, relative, command):
    outdir = resolve_outdir(workspace, relative)
    outdir.mkdir(parents=True, exist_ok=True)
    request = outdir / "request.txt"
    transcript = outdir / "transcript.jsonl"
    if any(path.exists() or path.is_symlink() for path in (request, transcript)):
        raise ValueError(f"probe files already exist in {outdir}; choose a new --outdir")
    with request.open("xb") as saved:
        saved.write(sys.stdin.buffer.read())
    with request.open("rb") as source, transcript.open("xb") as saved:
        with subprocess.Popen(command, cwd=workspace, stdin=source, stdout=subprocess.PIPE) as child:
            for chunk in iter(lambda: child.stdout.read1(64 * 1024), b""):
                saved.write(chunk)
                saved.flush()
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            return child.wait()


if __name__ == "__main__":
    try:
        sys.exit(run(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
