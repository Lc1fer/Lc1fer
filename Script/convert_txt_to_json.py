"""Convert four managed TXT rule sets to sing-box JSON; the workflow compiles SRS."""

import argparse
import ipaddress
import json
from pathlib import Path
import sys
import tempfile

BASE_DIR = Path(__file__).resolve().parent.parent / "Rule"
RULE_NAMES = ("direct", "fix", "proxy", "reject")
RULE_TYPES = {
    "DOMAIN": "domain",
    "DOMAIN-SUFFIX": "domain_suffix",
    "DOMAIN-KEYWORD": "domain_keyword",
    "IP-CIDR": "ip_cidr",
    "IP-CIDR6": "ip_cidr",
}


def process_file(txt_path):
    """Validate rules and remove duplicates while preserving input order."""
    txt_path = Path(txt_path)
    rules = {field: {} for field in RULE_TYPES.values()}
    with txt_path.open(encoding="utf-8-sig") as source:
        for line_number, raw_line in enumerate(source, 1):
            line = raw_line.strip()
            if not line or line.startswith(("#", "//", ";")):
                continue
            parts = [part.strip() for part in line.split(",")]
            key = parts[0].upper()
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
        data = {"version": 1, "rules": [rules] if rules else []}
        content = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        outputs.append((output_dir / f"{name}.json", content, sum(map(len, rules.values()))))

    output_dir.mkdir(parents=True, exist_ok=True)
    for path, content, count in outputs:
        if path.exists() and path.read_bytes() == content:
            print(f"{path.name}: {count} rules, unchanged")
            continue
        # Replace each file atomically to avoid a partially written JSON.
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
