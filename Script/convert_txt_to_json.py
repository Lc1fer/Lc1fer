import os
import json

BASE_DIR = 'Rule'

RULE_TYPES = {
    'DOMAIN': 'domain',
    'DOMAIN-SUFFIX': 'domain_suffix',
    'DOMAIN-KEYWORD': 'domain_keyword',
    'IP-CIDR': 'ip_cidr',
    'IP-CIDR6': 'ip_cidr'
}

def process_file(txt_path):
    rule_set = {v: [] for v in RULE_TYPES.values()}
    
    with open(txt_path, 'r') as txt_file:
        for line in txt_file:
            line = line.strip()
            if ',' in line:
                key, value = map(str.strip, line.split(',', 1))
                if key in RULE_TYPES:
                    if key.startswith('IP-CIDR'):
                        value = value.replace(',no-resolve', '').strip()
                    rule_set[RULE_TYPES[key]].append(value)
    
    return {k: v for k, v in rule_set.items() if v}

def convert_files():
    txt_files = [f for f in os.listdir(BASE_DIR) if f.endswith('.txt')]

    for file_name in txt_files:
        txt_path = os.path.join(BASE_DIR, file_name)
        json_path = os.path.join(BASE_DIR, file_name.replace('.txt', '.json'))

        rules = process_file(txt_path)

        json_data = {
            "version": 1,
            "rules": [rules]
        }

        with open(json_path, 'w') as json_file:
            json.dump(json_data, json_file, indent=2)

if __name__ == "__main__":
    convert_files()
