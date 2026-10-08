"""Regression tests for validation, SRS encoding and safe output publication."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zlib

import convert_txt_to_json as converter


class ConverterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rule-converter-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.source = self.directory / "source"
        self.output = self.directory / "output"
        self.source.mkdir()
        self.output.mkdir()
        for name in converter.RULE_NAMES:
            (self.source / f"{name}.txt").write_text("DOMAIN,a.com\n", encoding="utf-8")

    def convert(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            converter.convert_files(self.source, self.output, **kwargs)

    def test_parse_normalizes_ips_and_deduplicates_with_comments(self):
        source = self.source / "direct.txt"
        source.write_text("\ufeff# header\nDOMAIN,a.com\nDOMAIN,a.com # duplicate\n"
                          "IP-CIDR,192.0.2.1/24,no-resolve\nIP-CIDR6,2001:db8::1/64\n"
                          "GEOIP,CN\nPROCESS-NAME,app.exe\n", encoding="utf-8")
        self.assertEqual(converter.process_file(source), {
            "domain": ["a.com"], "ip_cidr": ["192.0.2.0/24", "2001:db8::/64"],
            "process_name": ["app.exe"],
        })

    def test_user_agent_requires_explicit_skip_and_logs_count(self):
        source = self.source / "direct.txt"
        source.write_text("USER-AGENT,SpeedTest*\nUSER-AGENT,TikTok*\nDOMAIN,a.com\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, r"direct.txt:1: unsupported rule type"):
            converter.process_file(source)
        warning = io.StringIO()
        with contextlib.redirect_stderr(warning):
            rules = converter.process_file(source, skip_unsupported_types=["USER-AGENT"])
        self.assertEqual(rules, {"domain": ["a.com"]})
        self.assertIn("skipped 2 USER-AGENT", warning.getvalue())
        source.write_text("UNKNOWN,a\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "unsupported rule type"):
            converter.process_file(source, skip_unsupported_types=["USER-AGENT"])

    def test_invalid_ip_and_malformed_skipped_rules_still_fail(self):
        source = self.source / "direct.txt"
        for line, message in [("IP-CIDR,::1/128", "IP version"),
                              ("USER-AGENT,", "missing rule value"),
                              ("USER-AGENT,TikTok*,extra", "unexpected extra fields")]:
            with self.subTest(line=line):
                source.write_text(line + "\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, message):
                    converter.process_file(source, skip_unsupported_types=["USER-AGENT"])

    def test_domain_matcher_wire_format_keeps_unicode_and_suffix_markers(self):
        # SRS v1 fixture from the existing encoder; covers exact/root/subdomain-only matching.
        expected = bytes.fromhex(
            "0001000000031400020002556aaaaaaab455540000000000000007216d"
            "e86faf63952ee6616579b56c6c8b706e2e6d6fe5612ead780d9065e42ebe0d8b"
        )
        self.assertEqual(converter.encode_domain_matcher(["a.com", "例子.测试"],
                                                        ["example.com", ".only.com"]), expected)
        self.assertEqual(converter.encode_domain_matcher(["例子.测试", "a.com", "a.com"],
                                                        [".only.com", "example.com"]), expected)

    def test_process_and_network_are_separate_or_rules_in_json_and_srs(self):
        source = self.source / "direct.txt"
        source.write_text("DOMAIN-KEYWORD,foo\nPROCESS-NAME,app\n", encoding="utf-8")
        self.convert()
        data = json.loads((self.output / "direct.json").read_text())
        self.assertEqual(data, {"version": 1, "rules": [
            {"domain_keyword": ["foo"]}, {"process_name": ["app"]},
        ]})
        binary = (self.output / "direct.srs").read_bytes()
        self.assertEqual(binary[:4], b"SRS\x01")
        # Two default rules, string item 3 then item 11, each ends with invert=false.
        self.assertEqual(zlib.decompress(binary[4:]),
                         b"\x02\x00\x03\x01\x03foo\xff\x00\x00\x0b\x01\x03app\xff\x00")

    def test_empty_rules_generate_valid_empty_json_and_srs(self):
        for name in converter.RULE_NAMES:
            (self.source / f"{name}.txt").write_text("# empty\nGEOIP,CN\n")
        self.convert()
        self.assertEqual(json.loads((self.output / "direct.json").read_text()), {"version": 1, "rules": []})
        self.assertEqual(zlib.decompress((self.output / "direct.srs").read_bytes()[4:]), b"\x00")

    def test_unchanged_outputs_keep_bytes_and_modification_times(self):
        self.convert()
        first = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.output.iterdir()}
        self.convert()
        second = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.output.iterdir()}
        self.assertEqual(first, second)
        self.assertEqual(len(second), 8)

    def test_late_validation_and_encoding_failure_never_publish_partial_outputs(self):
        self.convert()
        first = {p.name: p.read_bytes() for p in self.output.iterdir()}
        (self.source / "direct.txt").write_text("DOMAIN,new.com\n")
        (self.source / "reject.txt").write_text("INVALID,bad\n")
        with self.assertRaises(ValueError):
            self.convert()
        self.assertEqual({p.name: p.read_bytes() for p in self.output.iterdir()}, first)
        (self.source / "reject.txt").write_text("DOMAIN,b.com\n")
        encode = converter.encode_srs
        calls = 0

        def fail_late(rules):
            nonlocal calls
            calls += 1
            if calls == 4:
                raise ValueError("encoding failed")
            return encode(rules)

        with patch.object(converter, "encode_srs", side_effect=fail_late):
            with self.assertRaisesRegex(ValueError, "encoding failed"):
                self.convert()
        self.assertEqual({p.name: p.read_bytes() for p in self.output.iterdir()}, first)


if __name__ == "__main__":
    unittest.main()
