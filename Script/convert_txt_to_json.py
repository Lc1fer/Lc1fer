import os
import json

files_to_convert = ['direct.txt', 'proxy.txt', 'reject.txt']
base_dir = 'Rule'

for file_name in files_to_convert:
    txt_path = os.path.join(base_dir, file_name)
    json_path = os.path.join(base_dir, file_name.replace('.txt', '.json'))

    with open(txt_path, 'r') as txt_file:
        lines = txt_file.readlines()

    data = [line.strip() for line in lines if line.strip()]

    with open(json_path, 'w') as json_file:
        json.dump(data, json_file, indent=4)
