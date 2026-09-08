const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join('Rule', 'merge.yaml');
const OUTPUT_DIR = 'Rule';


/**
 * 解析 merge.yaml
 *
 * 格式：
 *
 * direct:
 *   url:
 *     - https://example.com/direct.list
 *   rules:
 *     - DOMAIN-SUFFIX,example.com
 *
 * direct+:
 *   url: []
 *   rules: []
 *
 * 所有顶层键都会自动作为规则文件名：
 *
 * direct   -> Rule/direct.txt
 * direct+  -> Rule/direct+.txt
 * proxy    -> Rule/proxy.txt
 */
function parseConfig(text) {
  const result = {};
  const lines = text.replace(/\r/g, '').split('\n');

  let currentName = null;
  let currentSection = null;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trim();

    // 跳过空行和注释
    if (!line || line.startsWith('#')) {
      continue;
    }

    const indent = raw.match(/^\s*/)[0].length;


    // ==========================================
    // 顶层规则分类
    //
    // direct:
    // proxy:
    // direct+:
    // ==========================================
    if (indent === 0 && line.endsWith(':')) {
      currentName = line.slice(0, -1).trim();

      if (!/^[A-Za-z0-9._+-]+$/.test(currentName)) {
        throw new Error(
          `Line ${index + 1}: invalid rule name "${currentName}"`
        );
      }

      if (result[currentName]) {
        throw new Error(
          `Line ${index + 1}: duplicate rule name "${currentName}"`
        );
      }

      result[currentName] = {
        url: [],
        rules: [],
      };

      currentSection = null;
      continue;
    }


    // ==========================================
    // url: []
    // rules: []
    // ==========================================
    if (indent === 2 && currentName) {
      const emptyMatch = line.match(
        /^(url|rules):\s*\[\s*\]$/
      );

      if (emptyMatch) {
        currentSection = null;
        continue;
      }


      // ========================================
      // url:
      // rules:
      // ========================================
      const sectionMatch = line.match(
        /^(url|rules):$/
      );

      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }
    }


    // ==========================================
    // 列表内容
    //
    //   url:
    //     - https://example.com/a.list
    //
    //   rules:
    //     - DOMAIN-SUFFIX,example.com
    // ==========================================
    if (
      indent >= 4 &&
      currentName &&
      currentSection &&
      line.startsWith('- ')
    ) {
      const value = line.slice(2).trim();

      if (
        value &&
        !value.startsWith('#')
      ) {
        result[currentName][currentSection].push(value);
      }

      continue;
    }


    throw new Error(
      `Line ${index + 1}: unsupported syntax: ${line}`
    );
  }


  if (Object.keys(result).length === 0) {
    throw new Error('No rule categories found');
  }

  return result;
}


/**
 * 清理规则：
 *
 * - CRLF -> LF
 * - 删除首尾空格
 * - 删除空行
 * - 删除 # 注释行
 */
function cleanRules(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        line &&
        !line.startsWith('#')
    );
}


/**
 * 去重并使用 ASCII 顺序排序
 */
function sortUnique(lines) {
  return [...new Set(lines)].sort(
    (a, b) => {
      if (a === b) {
        return 0;
      }

      return a < b ? -1 : 1;
    }
  );
}


/**
 * 延迟
 */
function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


/**
 * 下载远程规则
 *
 * - 自动跟随重定向
 * - 60 秒超时
 * - 最多尝试 3 次
 * - 失败后间隔 2 秒
 */
async function download(url, retries = 3) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= retries;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        60000
      );

    try {
      const response =
        await fetch(url, {
          redirect: 'follow',

          signal:
            controller.signal,

          headers: {
            'User-Agent':
              'GitHub-Actions-Rule-Merger',
          },
        });


      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`
        );
      }


      return await response.text();


    } catch (error) {
      lastError = error;


      if (attempt < retries) {
        console.log(
          `  Retry ${attempt}/${retries - 1}: ${url}`
        );

        await sleep(2000);
      }


    } finally {
      clearTimeout(timeout);
    }
  }


  throw lastError;
}


/**
 * 比较两个规则数组
 */
function rulesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  return a.every(
    (rule, index) =>
      rule === b[index]
  );
}


/**
 * 获取北京时间
 *
 * 输出：
 * 2026-09-08 09:30
 */
function getUpdateTime() {
  const formatter =
    new Intl.DateTimeFormat(
      'sv-SE',
      {
        timeZone:
          'Asia/Shanghai',

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit',

        hour:
          '2-digit',

        minute:
          '2-digit',

        hour12:
          false,
      }
    );

  return formatter.format(
    new Date()
  );
}


/**
 * 生成单个规则文件
 */
async function generateRule(
  name,
  config
) {
  const output =
    path.join(
      OUTPUT_DIR,
      `${name}.txt`
    );


  const externalRules = [];


  // ==========================================
  // 下载外部 URL
  //
  // 任意一个 URL 下载失败：
  // 不覆盖当前规则文件
  // ==========================================
  if (config.url.length > 0) {
    for (const url of config.url) {
      console.log(
        `Downloading: ${url}`
      );


      try {
        const content =
          await download(url);


        externalRules.push(
          ...cleanRules(content)
        );


        console.log(
          '  ✓ Success'
        );


      } catch (error) {
        console.error(
          `  ✗ Failed: ${error.message}`
        );


        console.warn(
          `SKIP: ${output} will not be overwritten.`
        );


        return false;
      }
    }
  }


  // ==========================================
  // 自定义规则
  // ==========================================
  const customRules =
    config.rules
      .map(
        line => line.trim()
      )
      .filter(
        line =>
          line &&
          !line.startsWith('#')
      );


  // ==========================================
  // url 和 rules 都为空
  //
  // 保留原文件
  // ==========================================
  if (
    config.url.length === 0 &&
    customRules.length === 0
  ) {
    console.log(
      `SKIP: ${name} has no URLs or custom rules.`
    );

    return false;
  }


  // ==========================================
  // 合并
  // 去重
  // 排序
  // ==========================================
  const newRules =
    sortUnique([
      ...externalRules,
      ...customRules,
    ]);


  if (newRules.length === 0) {
    console.warn(
      `SKIP: generated rules are empty for ${name}.`
    );

    return false;
  }


  // ==========================================
  // 读取旧文件规则正文
  //
  // cleanRules 会自动删除：
  //
  // # 更新时间：xxxx
  //
  // 所以比较时不会受更新时间影响
  // ==========================================
  let oldRules = [];


  if (fs.existsSync(output)) {
    oldRules =
      sortUnique(
        cleanRules(
          fs.readFileSync(
            output,
            'utf8'
          )
        )
      );
  }


  // ==========================================
  // 只有正文变化才覆盖
  // ==========================================
  if (
    fs.existsSync(output) &&
    rulesEqual(
      newRules,
      oldRules
    )
  ) {
    console.log(
      `UNCHANGED: ${output}`
    );

    return false;
  }


  // ==========================================
  // 生成文件
  //
  // 第一行：
  // # 更新时间：YYYY-MM-DD HH:mm
  //
  // 第二行：
  // 空行
  //
  // 第三行开始：
  // 规则
  //
  // 最后一条规则后只保留一个 \n
  // 不产生额外空白行
  // ==========================================
  const updateTime =
    getUpdateTime();


  const content =
    `# 更新时间：${updateTime}\n\n` +
    `${newRules.join('\n')}\n`;


  fs.writeFileSync(
    output,
    content,
    'utf8'
  );


  console.log(
    `UPDATED: ${output}`
  );


  console.log(
    `Unique rules: ${newRules.length}`
  );


  return true;
}


/**
 * 主程序
 */
async function main() {

  if (
    !fs.existsSync(
      CONFIG_FILE
    )
  ) {
    throw new Error(
      `${CONFIG_FILE} not found`
    );
  }


  // ==========================================
  // 读取 merge.yaml
  // ==========================================
  const config =
    parseConfig(
      fs.readFileSync(
        CONFIG_FILE,
        'utf8'
      )
    );


  const names =
    Object.keys(config);


  console.log(
    'Discovered rule sets:'
  );


  names.forEach(
    name =>
      console.log(
        `  - ${name}`
      )
  );


  console.log('');


  let changed = 0;


  // ==========================================
  // 自动处理所有分类
  // ==========================================
  for (const name of names) {

    const updated =
      await generateRule(
        name,
        config[name]
      );


    if (updated) {
      changed++;
    }
  }


  console.log('');


  console.log(
    `Changed rule files: ${changed}`
  );
}


main().catch(
  error => {

    console.error(
      `ERROR: ${error.message}`
    );


    process.exit(1);
  }
);