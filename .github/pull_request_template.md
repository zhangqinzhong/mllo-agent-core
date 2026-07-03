## 变更说明


## Runtime Contract 影响

- [ ] 没有改变公开 API、事件协议、会话格式、工具 schema 或权限语义
- [ ] 如果有改变，已经更新 `docs/RUNTIME_CONTRACT.md` 和相关 README

## 自测

- [ ] `npm run verify`

## 审查重点

- [ ] 会话、JSONL、checkpoint 或 state 变更具备兼容策略
- [ ] 工具调用、权限判断和路径访问没有扩大风险面
- [ ] 新增公开文档不包含私有路径、内部仓库信息或非公开产品规划
- [ ] 新增文件会进入正确的 npm 包边界，或被明确排除

## 备注
