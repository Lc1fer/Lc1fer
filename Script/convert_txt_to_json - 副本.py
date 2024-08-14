import os
import json

# 配置目录
BASE_DIR = 'Rule'

# 规则类型定义，可以方便地在这里添加或修改规则类型
RULE_TYPES = {
    'DOMAIN': 'domain',
    'DOMAIN-SUFFIX': 'domain_suffix',
    'DOMAIN-KEYWORD': 'domain_keyword',
    'IP-CIDR': 'ip_cidr',
    'IP-CIDR6': 'ip_cidr'
}

# 创建规则模板
def create_rule_set():
    return {v: [] for v in RULE_TYPES.values()}

# 移除空的字段
def remove_empty_fields(rules):
    return {k: v for k, v in rules.items() if v}

# 处理单个文件
def process_file(txt_path):
    rule_set = create_rule_set()
    
    with open(txt_path, 'r') as txt_file:
        for line in txt_file:
            line = line.strip()
            # 确保行中有逗号，且能分割成 key 和 value 两部分
            if ',' in line:
                key, value = map(str.strip, line.split(',', 1))
                
                if key in RULE_TYPES:
                    # 处理 IP-CIDR 特殊情况
                    if key == 'IP-CIDR':
                        value = value.replace(',no-resolve', '').strip()
                    rule_set[RULE_TYPES[key]].append(value)
    
    return remove_empty_fields(rule_set)

# 主函数，转换所有文件
def convert_files():
    # 获取 Rule 目录下所有的 txt 文件
    txt_files = [f for f in os.listdir(BASE_DIR) if f.endswith('.txt')]

    for file_name in txt_files:
        txt_path = os.path.join(BASE_DIR, file_name)
        json_path = os.path.join(BASE_DIR, file_name.replace('.txt', '.json'))

        if not os.path.exists(txt_path):
            continue

        json_data = {
            "version": 1,
            "rules": [process_file(txt_path)]
        }

        with open(json_path, 'w') as json_file:
            json.dump(json_data, json_file, indent=2)

# 执行转换
if __name__ == "__main__":
    convert_files()
