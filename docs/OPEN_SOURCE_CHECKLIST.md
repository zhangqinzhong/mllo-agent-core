# 发布前检查

开源发布前至少跑这几类检查。

## 代码边界

```bash
npm run typecheck
npm run build
```

确认没有依赖：

```text
Electron
React
renderer
desktop shell
private app IPC
```

## 品牌和来源痕迹

开源包不应出现其他 agent 产品名、私有仓库路径或宿主应用品牌。

建议发布前用内部清洁扫描脚本检查第三方产品名和私有路径；扫描应无输出。

## Runtime 数据

不要提交：

```text
node_modules/
dist/
*.sqlite
*.jsonl
dump-prompts/
```

## 文档

README 至少要说明：

```text
1. 这个 core 负责什么
2. 不负责什么
3. 怎么嵌入
4. 怎么配置模型
5. session/runtime home 写到哪里
6. prompt dump 如何开启
```

## 安全

确认示例中没有：

```text
真实 API key
真实用户路径
私有 base URL
私有模型名
```
