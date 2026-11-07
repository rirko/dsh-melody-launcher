# DSH 旋律启动器 v0.5.3

本版本修复旧设置文件导致 Profile 无法读取的问题。

## What's Changed

- 修复 `settings.json` 中 `dshHome`、工作目录或启动命令被保存为数组时，启动阶段 `profile:read` 抛出 `ERR_INVALID_ARG_TYPE` 的问题。
- 自动迁移早期文件选择器产生的单元素路径数组。
- 对非法或多元素数组使用安全默认值，避免 `path.join()` 收到非字符串参数。
- 增加对应的设置迁移测试。

**Full Changelog**: https://github.com/rirko/dsh-melody-launcher/compare/v0.5.2...v0.5.3
