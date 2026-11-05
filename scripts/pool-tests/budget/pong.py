"""Observe empty Redis pubsub PONGs on loopback; never retain packet contents."""
import json
import os
from pathlib import Path
import signal
import socket
import struct
import sys
import time

PATTERN = b'*2\r\n$4\r\npong\r\n$0\r\n\r\n'


def payload(packet):
    if len(packet) < 54 or packet[12:14] != b'\x08\x00':
        return None
    ip = 14
    if packet[ip + 9] != 6:
        return None
    tcp = ip + (packet[ip] & 15) * 4
    if len(packet) < tcp + 20:
        return None
    source, destination, sequence = struct.unpack('!HHI', packet[tcp:tcp + 8])
    if source != 8327:
        return None
    end = tcp + ((packet[tcp + 12] >> 4) * 4)
    return (packet[ip + 12:ip + 20], destination), sequence, packet[end:]


def main():
    output = Path(sys.argv[1])
    started = float(sys.argv[2])
    Path(str(output) + '.pid').write_text(str(os.getpid()))
    result = {'captureStartedMs': time.time() * 1000, 'pongArrivalMs': [],
              'measurement': 'empty Redis pubsub PONG on loopback, wire arrival; not node processing'}
    def save(*_args):
        output.write_text(json.dumps(result) + '\n')
    signal.signal(signal.SIGTERM, lambda *_: (save(), sys.exit(0)))
    capture = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
    capture.bind(('lo', 0))
    capture.settimeout(1)
    result['captureReadyMs'] = time.time() * 1000
    save()
    streams = {}
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            packet = capture.recv(65536)
        except TimeoutError:
            continue
        decoded = payload(packet)
        if not decoded:
            continue
        flow, seq, data = decoded
        if not data:
            continue
        previous_seq, previous = streams.get(flow, (seq, b''))
        if seq < previous_seq:
            continue  # Loopback packet duplicate or TCP retransmission.
        if seq != previous_seq:
            previous = b''
        buffer = previous + data
        while PATTERN in buffer.lower():
            index = buffer.lower().index(PATTERN)
            result['pongArrivalMs'].append(round(time.time() * 1000 - started, 3))
            buffer = buffer[index + len(PATTERN):]
            save()
        streams[flow] = (seq + len(data), buffer[-64:])
    save()


if __name__ == '__main__':
    main()
