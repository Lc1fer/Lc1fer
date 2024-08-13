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

    # 确保文件路径正确
    if not os.path.exists(txt_path):
        print(f"Error: {txt_path} does not exist.")
        continue

    # 初始化 JSON 数据结构
    json_data = {
        "version": 1,
        "rules": create_empty_rule_set()
    }

    with open(txt_path, 'r') as txt_file:
        lines = txt_file.readlines()

    if not lines:
        print(f"Warning: {file_name} is empty.")
    else:
        print(f"Processing {file_name}...")

    # 解析 txt 文件内容并填充到 JSON 结构中
    for line in lines:
        line = line.strip()
        print(f"Reading line: {line}")  # 添加调试信息

        # 使用逗号分隔符解析行内容
        if ',' in line:
            key, value = line.split(',', 1)
            value = value.strip()

            if key == 'DOMAIN':
                json_data['rules']['domain'].append(value)
            elif key == 'DOMAIN-SUFFIX':
                json_data['rules']['domain_suffix'].append(value)
            elif key == 'DOMAIN-KEYWORD':
                json_data['rules']['domain_keyword'].append(value)
            elif key == 'IP-CIDR':
                json_data['rules']['ip_cidr'].append(value)
            else:
                print(f"Unknown key in {file_name}: {key}")  # 添加调试信息
        else:
            print(f"Skipping invalid line in {file_name}: {line}")

    # 检查是否有数据被添加到 JSON
    if not any(json_data['rules'].values()):
        print(f"Warning: No valid data found in {file_name}.")
    
    # 将结构化的数据保存为 JSON 文件
    with open(json_path, 'w') as json_file:
        json.dump(json_data, json_file, indent=4)

    print(f"Conversion completed for {file_name} and saved to {json_path}")
