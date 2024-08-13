import os
import json

# 配置文件和目录
FILES_TO_CONVERT = ['direct.txt', 'proxy.txt', 'reject.txt']
BASE_DIR = 'Rule'

# 定义 JSON 结构的模板
def create_rule_set():
    return {
        "domain": [],
        "domain_suffix": [],
        "domain_keyword": [],
        "ip_cidr": []
    }

# 移除空的字段
def remove_empty_fields(rules):
    return {k: v for k, v in rules.items() if v}

# 处理单个文件
def process_file(txt_path):
    rule_set = create_rule_set()
    
    with open(txt_path, 'r') as txt_file:
        for line in txt_file:
            key, value = map(str.strip, line.split(',', 1))
            
            if key == 'DOMAIN':
                rule_set['domain'].append(value)
            elif key == 'DOMAIN-SUFFIX':
                rule_set['domain_suffix'].append(value)
            elif key == 'DOMAIN-KEYWORD':
                rule_set['domain_keyword'].append(value)
            elif key == 'IP-CIDR':
                rule_set['ip_cidr'].append(value.replace(',no-resolve', '').strip())
    
    return remove_empty_fields(rule_set)

# 主函数，转换所有文件
def convert_files():
    for file_name in FILES_TO_CONVERT:
        txt_path = os.path.join(BASE_DIR, file_name)
        json_path = os.path.join(BASE_DIR, file_name.replace('.txt', '.json'))

        if not os.path.exists(txt_path):
            continue

        json_data = {
            "version": 2,
            "rules": [process_file(txt_path)]
        }

        with open(json_path, 'w') as json_file:
            json.dump(json_data, json_file, indent=2)

# 执行转换
if __name__ == "__main__":
    convert_files()
