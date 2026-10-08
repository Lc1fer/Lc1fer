# TXT 转 JSON / SRS

脚本仅依赖 Python 标准库，默认转换仓库 Rule 目录中的 direct、fix、proxy、reject 四份 TXT，生成同名 JSON 和 SRS v1 文件。默认路径相对于脚本所在仓库，不受启动目录影响。

当前仓库含 sing-box 无对应字段的 USER-AGENT 规则，需要显式跳过：

```bash
python Script/convert_txt_to_json.py --skip-unsupported-type USER-AGENT
```

可用 `--rule-dir` 指定输入目录、`--output-dir` 指定输出目录。Script/txt-json-binary.yml 是工作流模板，使用前需放到 .github/workflows/txt-json-binary.yml。

支持 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、IP-CIDR、IP-CIDR6 和 PROCESS-NAME。规则按首次出现的顺序去重，IP 网段会规范化，IP 规则允许 no-resolve。支持 BOM、空行、整行注释和空白分隔的行尾注释。

PROCESS-NAME 独立生成一条规则，与域名/IP 规则形成或关系，避免 sing-box 将进程条件与网络条件组合为与关系。域名树保留 SRS v1 的后缀语义和 Unicode 编码顺序，构建时复用已有节点、序列化时释放已遍历节点。

GEOIP 延续既有行为，只保留在 TXT 中。USER-AGENT 默认报错；显式跳过时按文件打印跳过数量，TXT 原文件不会修改。其他未知类型、缺失值、错误 IP 版本及多余字段仍报错并显示文件与行号。

逐个输入校验并编码到输出目录的临时子目录，内存只保留当前分类。八份文件全部生成成功后，再逐份原子替换；比较内容时分块读取。校验或编码失败不发布任何文件；内容未变时保留原文件及修改时间。发布阶段发生文件系统错误时，已完成的替换不会回滚。临时目录结束时自动清理。

运行回归测试：

```bash
python -m unittest discover -s Script -p 'test_*.py' -v
```

测试使用临时目录，覆盖规则校验、显式跳过、进程规则分组、SRS 二进制格式、空规则、重复运行及失败时输出保护。
