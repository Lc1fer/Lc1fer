import os
import subprocess

# 要编译的 JSON 文件列表
files_to_compile = ['direct.json', 'proxy.json', 'reject.json']
base_dir = 'Rule'

def compile_json_to_srs(json_path, srs_path):
    try:
        # 使用 subprocess 运行命令
        result = subprocess.run(
            ['sing-box', 'rule-set', 'compile', '--output', srs_path, json_path],
            check=True,  # 如果命令返回非零退出码，抛出异常
            capture_output=True,  # 捕获输出以便检查或记录
            text=True  # 将输出作为字符串处理
        )
        print(f"Successfully compiled {json_path} to {srs_path}")
        print(result.stdout)  # 打印命令输出
    except subprocess.CalledProcessError as e:
        print(f"Failed to compile {json_path}: {e}")
        print(e.stderr)  # 打印错误信息

# 主函数
if __name__ == '__main__':
    for file_name in files_to_compile:
        json_path = os.path.join(base_dir, file_name)
        srs_path = os.path.join(base_dir, file_name.replace('.json', '.srs'))
        print(f"Compiling {json_path} to {srs_path}...")
        compile_json_to_srs(json_path, srs_path)
