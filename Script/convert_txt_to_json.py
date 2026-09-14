"""Convert four managed TXT rule sets to JSON and SRS using only Python's stdlib."""

import argparse
from collections import deque
import ipaddress
import json
from pathlib import Path
import re
import sys
import tempfile
import zlib

BASE_DIR = Path(__file__).resolve().parent.parent / "Rule"
RULE_NAMES = ("direct", "fix", "proxy", "reject")
RULE_TYPES = {
    "DOMAIN": "domain",
    "DOMAIN-SUFFIX": "domain_suffix",
    "DOMAIN-KEYWORD": "domain_keyword",
    "IP-CIDR": "ip_cidr",
    "IP-CIDR6": "ip_cidr",
}
SRS_VERSION = 1


def uvarint(value):
    """Encode an unsigned base-128 integer (Go encoding/binary format)."""
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def sized_bytes(value):
    return uvarint(len(value)) + value


def encode_domain_matcher(domains, suffixes):
    """Serialize a breadth-first succinct trie with SRS v1 suffix markers.

    Format references (wire compatibility, no runtime dependencies):
    github.com/SagerNet/sing/blob/v0.7.0/common/domain/{matcher,set}.go
    A suffix without a leading dot includes the root and all subdomains;
    a leading dot matches subdomains only. Reverse Unicode characters before
    UTF-8 encoding, as the official matcher does.
    """
    suffixes = set(suffixes)
    roots = {value for value in suffixes if not value.startswith(".")}
    subdomains = {value if value.startswith(".") else "." + value for value in suffixes}
    exact = (set(domains) - suffixes - subdomains) | roots
    keys = exact | {"\r" + value for value in subdomains}

    # None marks a terminal node; integer keys are UTF-8 edge labels.
    trie = {}
    for key in keys:
        node = trie
        for label in key[::-1].encode("utf-8"):
            node = node.setdefault(label, {})
        node[None] = True

    leaves, bitmap, labels = [], [], bytearray()

    def bit(words, index, value):
        while len(words) <= index // 64:
            words.append(0)
        words[index // 64] |= value << (index % 64)

    pending = deque([trie])
    node_id = bitmap_index = 0
    while pending:
        node = pending.popleft()
        bit(leaves, node_id, int(None in node))
        for label in sorted(key for key in node if key is not None):
            labels.append(label)
            pending.append(node[label])
            bit(bitmap, bitmap_index, 0)
            bitmap_index += 1
        bit(bitmap, bitmap_index, 1)
        bitmap_index += 1
        node_id += 1

    def words_bytes(words):
        return uvarint(len(words)) + b"".join(word.to_bytes(8, "big") for word in words)

    return b"\x00" + words_bytes(leaves) + words_bytes(bitmap) + sized_bytes(labels)


def encode_ip_set(cidrs):
    """Encode the sorted union of inclusive IP ranges, separately by family.

    Wire format: SagerNet/sing-box v1.12.0 common/srs/ip_set.go.
    Range count is a fixed-width uint64; address lengths are uvarints.
    """
    ranges = []
    for cidr in cidrs:
        network = ipaddress.ip_network(cidr)
        ranges.append((network.version, int(network.network_address), int(network.broadcast_address)))
    merged = []
    for version, start, end in sorted(ranges):
        if merged and merged[-1][0] == version and start <= merged[-1][2] + 1:
            previous = merged[-1]
            merged[-1] = (version, previous[1], max(previous[2], end))
        else:
            merged.append((version, start, end))
    result = bytearray(b"\x01" + len(merged).to_bytes(8, "big"))
    for version, start, end in merged:
        width = 4 if version == 4 else 16
        result.extend(sized_bytes(start.to_bytes(width, "big")))
        result.extend(sized_bytes(end.to_bytes(width, "big")))
    return bytes(result)


def encode_srs(rules):
    """Encode only the fields accepted by this TXT converter, as SRS v1.

    Layout: SagerNet/sing-box v1.12.0 common/srs/binary.go.
    Keep the version fixed; new rule types require explicit encoder support.
    """
    unsupported = rules.keys() - set(RULE_TYPES.values())
    if unsupported:
        raise ValueError(f"unsupported SRS fields: {', '.join(sorted(unsupported))}")
    payload = bytearray(uvarint(1 if rules else 0))
    if rules:
        payload.append(0)  # Default (non-logical) rule.
        if rules.get("domain") or rules.get("domain_suffix"):
            payload.append(2)
            payload.extend(encode_domain_matcher(rules.get("domain", []), rules.get("domain_suffix", [])))
        if rules.get("domain_keyword"):
            keywords = rules["domain_keyword"]
            payload.append(3)
            payload.extend(uvarint(len(keywords)))
            for keyword in keywords:
                payload.extend(sized_bytes(keyword.encode("utf-8")))
        if rules.get("ip_cidr"):
            payload.append(6)
            payload.extend(encode_ip_set(rules["ip_cidr"]))
        payload.extend(b"\xff\x00")  # End of items, invert=false.
    return b"SRS" + bytes([SRS_VERSION]) + zlib.compress(payload, level=9)


def process_file(txt_path):
    """Skip GEOIP during conversion; validate and deduplicate other rules."""
    txt_path = Path(txt_path)
    rules = {field: {} for field in RULE_TYPES.values()}
    with txt_path.open(encoding="utf-8-sig") as source:
        for line_number, raw_line in enumerate(source, 1):
            line = raw_line.strip()
            if not line or line.startswith(("#", "//", ";")):
                continue
            # Existing TXT rules use whitespace-separated trailing comments.
            line = re.split(r"\s+(?://|#|;)", line, maxsplit=1)[0].rstrip()
            parts = [part.strip() for part in line.split(",")]
            key = parts[0].upper()
            # Keep GEOIP in the source TXT, but omit it from JSON and SRS.
            if key == "GEOIP":
                continue
            try:
                if key not in RULE_TYPES:
                    raise ValueError(f"unsupported rule type: {parts[0]}")
                if len(parts) < 2 or not parts[1]:
                    raise ValueError("missing rule value")
                is_ip = key in ("IP-CIDR", "IP-CIDR6")
                if len(parts) != 2 and not (
                    is_ip and len(parts) == 3 and parts[2].lower() == "no-resolve"
                ):
                    raise ValueError("unexpected extra fields (only IP no-resolve is supported)")
                value = parts[1]
                if any(character.isspace() for character in value):
                    raise ValueError("whitespace inside rule value")
                if is_ip:
                    network = ipaddress.ip_network(value, strict=False)
                    expected_version = 6 if key == "IP-CIDR6" else 4
                    if network.version != expected_version:
                        raise ValueError(f"IP version does not match {key}")
                    value = str(network)
                rules[RULE_TYPES[key]][value] = None
            except ValueError as error:
                raise ValueError(f"{txt_path}:{line_number}: {error}") from error
    return {field: list(values) for field, values in rules.items() if values}


def convert_files(base_dir=BASE_DIR, output_dir=None):
    base_dir = Path(base_dir)
    output_dir = Path(output_dir) if output_dir is not None else base_dir
    outputs = []
    # Validate every input before writing any output.
    for name in RULE_NAMES:
        rules = process_file(base_dir / f"{name}.txt")
        data = {"version": SRS_VERSION, "rules": [rules] if rules else []}
        content = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        count = sum(map(len, rules.values()))
        outputs.append((output_dir / f"{name}.json", content, count))
        outputs.append((output_dir / f"{name}.srs", encode_srs(rules), count))

    output_dir.mkdir(parents=True, exist_ok=True)
    for path, content, count in outputs:
        if path.exists() and path.read_bytes() == content:
            print(f"{path.name}: {count} rules, unchanged")
            continue
        # Replace each file atomically to avoid partially written output.
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=output_dir, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(content)
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print(f"{path.name}: {count} rules, updated")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rule-dir", type=Path, default=BASE_DIR)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    try:
        convert_files(args.rule_dir, args.output_dir)
    except (OSError, ValueError) as error:
        print(f"Conversion failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
