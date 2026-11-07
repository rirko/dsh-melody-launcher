# DSH 旋律启动器 v0.5.1

本版本包含官方整合包入口和 Profile 模型配置同步改进。

## What's Changed

### 官方整合包

- 增加官方整合包一键获取入口。
- 创建 Profile 前先校验所需依赖，减少导入后环境不完整的问题。
- 移除仓库特殊化推荐逻辑，统一按整合包和插件来源处理。

### Profile 模型配置同步

- 当前 Profile 的 `cordis.patch.yml` 作为模型 Provider 和默认模型的读取来源。
- API 配置编辑会写入当前 Profile，Profile 之间的模型配置保持独立。
- 增加“同步到全局设置”，将当前 Profile 的 Provider 和默认模型镜像到 `settings.yaml`。
- 同步时保留全局其他设置，并继续将密钥独立保存在凭据文件中。
- 支持多个模型及上下文窗口、最大输出 Token、输入类型和推理档位等参数。

### 修复与验证

- 修复 Profile 模型配置无法同步到全局设置的问题。
- 完整测试通过：104 个测试文件通过，1050 个测试通过。
- 生产构建通过。

**Full Changelog**: https://github.com/rirko/dsh-melody-launcher/compare/v0.5.0...v0.5.1
