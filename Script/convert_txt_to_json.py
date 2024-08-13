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

# 处理每个 txt 文件并生成对应的 json 文件
for file_name in files_to_convert:
    txt_path = os.path.join(base_dir, file_name)
    json_path = os.path.join(base_dir, file_name.replace('.txt', '.json'))

    # 初始化 JSON 数据结构
    json_data = {
        "version": 1,
        "rules": create_empty_rule_set()
    }

    with open(txt_path, 'r') as txt_file:
        lines = txt_file.readlines()

    # 解析 txt 文件内容并填充到 JSON 结构中
    for line in lines:
        line = line.strip()
        if line.startswith('DOMAIN'):
            json_data['rules']['domain'].append(line.split('=')[1].strip())
        elif line.startswith('DOMAIN-SUFFIX'):
            json_data['rules']['domain_suffix'].append(line.split('=')[1].strip())
        elif line.startswith('DOMAIN-KEYWORD'):
            json_data['rules']['domain_keyword'].append(line.split('=')[1].strip())
        elif line.startswith('IP-CIDR'):
            json_data['rules']['ip_cidr'].append(line.split('=')[1].strip())

    # 将结构化的数据保存为 JSON 文件
    with open(json_path, 'w') as json_file:
        json.dump(json_data, json_file, indent=4)

    print(f"Conversion completed for {file_name} and saved to {json_path}")
