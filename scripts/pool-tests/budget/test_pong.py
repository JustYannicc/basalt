import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('pong', Path(__file__).with_name('pong.py'))
pong = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pong)


class PacketTest(unittest.TestCase):
    def test_loopback_tcp_payload_and_sequence(self):
        ethernet = b'\0' * 12 + b'\x08\x00'
        ip = bytearray(20)
        ip[0], ip[9] = 0x45, 6
        tcp = bytearray(20)
        tcp[:8] = struct.pack('!HHI', 8327, 45000, 1234)
        tcp[12] = 0x50
        data = pong.PATTERN
        decoded = pong.payload(ethernet + ip + tcp + data)
        self.assertEqual(decoded[1:], (1234, data))
        tcp[:2] = struct.pack('!H', 8317)
        self.assertIsNone(pong.payload(ethernet + ip + tcp + data))

    def test_empty_pubsub_pong_excludes_telemetry_and_command_reply(self):
        self.assertIn(pong.PATTERN, b'prefix' + pong.PATTERN + b'suffix')
        self.assertNotIn(pong.PATTERN, b'+PONG\r\n')
        self.assertNotIn(pong.PATTERN, b'*2\r\n$4\r\npong\r\n$10\r\nhome-rtt/1\r\n')
        self.assertIsNone(pong.payload(b'short'))


if __name__ == '__main__':
    unittest.main()
