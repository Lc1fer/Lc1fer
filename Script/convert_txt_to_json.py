import os
import json

files_to_convert = ['direct.txt', 'proxy.txt', 'reject.txt']
base_dir = 'Rule'

# 定义 JSON 结构的模板
def create_empty_rule_set():
    return {
        "domain": [],
        "domain_suffix": [],
        "domain_keyword": [],
        "ip_cidr": []
    }

# 移除空的字段
def remove_empty_fields(rules):
    return {k: v for k, v in rules.items() if v}

# 处理每个 txt 文件并生成对应的 json 文件
for file_name in files_to_convert:
    txt_path = os.path.join(base_dir, file_name)
    json_path = os.path.join(base_dir, file_name.replace('.txt', '.json'))

    if not os.path.exists(txt_path):
        continue

    # 初始化 JSON 数据结构
    json_data = {
        "version": 2,
        "rules": [create_empty_rule_set()]  # 将 rules 改为列表，包含一个字典
    }

    with open(txt_path, 'r') as txt_file:
        lines = txt_file.readlines()

    # 解析 txt 文件内容并填充到 JSON 结构中
    for line in lines:
        line = line.strip()

        if ',' in line:
            key, value = line.split(',', 1)
            value = value.strip()

            if key == 'DOMAIN':
                json_data['rules'][0]['domain'].append(value)
            elif key == 'DOMAIN-SUFFIX':
                json_data['rules'][0]['domain_suffix'].append(value)
            elif key == 'DOMAIN-KEYWORD':
                json_data['rules'][0]['domain_keyword'].append(value)
            elif key == 'IP-CIDR':
                value = value.replace('no-resolve', '').strip()
                json_data['rules'][0]['ip_cidr'].append(value)

    # 移除空的字段
    json_data['rules'][0] = remove_empty_fields(json_data['rules'][0])

    # 将结构化的数据保存为 JSON 文件，并使用 2 个空格缩进
    with open(json_path, 'w') as json_file:
        json.dump(json_data, json_file, indent=2)
