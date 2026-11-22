"""Container health: both I1 ports accept connections. Route state is /status's job, not this."""

import socket
import sys


def main():
    try:
        socket.create_connection(("127.0.0.1", 8080), timeout=2).close()
        socket.create_connection(("127.0.0.1", 1080), timeout=2).close()
    except OSError:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
