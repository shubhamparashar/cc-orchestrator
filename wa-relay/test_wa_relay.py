"""Unit tests for resolve_sid tag routing in wa-relay.py.

Run: python3 -m unittest wa-relay/test_wa_relay.py -v  (from repo root)
"""
import importlib.util
import os
import unittest
from unittest.mock import patch

MODULE_PATH = os.path.join(os.path.dirname(__file__), 'wa-relay.py')
spec = importlib.util.spec_from_file_location('wa_relay', MODULE_PATH)
wa_relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wa_relay)

ENTRIES = [
    {'sid': 'sid-aaaaaaaa-1111', 'tag': 'aaaaaaaa', 'ts': '2026-09-08T10:00:00Z', 'cwd': '/repo/fleek-api'},
    {'sid': 'sid-bbbbbbbb-2222', 'tag': 'bbbbbbbb', 'ts': '2026-09-08T11:00:00Z', 'cwd': '/repo/fleek-api'},
]


class ResolveSidTest(unittest.TestCase):
    def _resolve(self, text):
        with patch.object(wa_relay, 'registry_entries', return_value=ENTRIES):
            return wa_relay.resolve_sid(text)

    def test_tagged_message_routes_to_work_sid(self):
        sid, how, hint = self._resolve('sid bbbbbbbb do the thing')
        self.assertEqual(sid, 'sid-bbbbbbbb-2222')
        self.assertIsNone(hint)

    def test_untagged_message_routes_to_bot_with_hint(self):
        sid, how, hint = self._resolve('what is the weather')
        self.assertEqual(sid, 'BOT')
        self.assertIn('aaaaaaaa', hint)
        self.assertIn('bbbbbbbb', hint)

    def test_unknown_tag_routes_to_bot_with_hint(self):
        sid, how, hint = self._resolve('sid deadbeef do the thing')
        self.assertEqual(sid, 'BOT')
        self.assertIn('not in registry', how)
        self.assertIn('aaaaaaaa', hint)


if __name__ == '__main__':
    unittest.main()
