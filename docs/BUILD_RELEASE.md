# GitHub Actions 打包

工作流为 `.github/workflows/package.yml`，使用 Ubuntu 24.04 runner、固定 Godot 4.7 标准版和官方导出模板，先运行十套 Godot 回归、跨进程存档检查与打包元数据测试，再导出 Windows 和 Android。编辑器和模板缓存到后续运行；初次需下载约 1.3 GB 的官方模板包。

项目为 GDScript，不需要 .NET 编译。Windows 可从 Linux 直接导出；Android 使用 Java 17、SDK 36 / Build Tools 36.1.0 和预编译 APK 模板，不启用 Gradle，也不需要安装 NDK 来编译引擎。通过固定版本的 `setup-android` 明确初始化 SDK 与命令路径，不依赖 runner 默认 PATH。`export_presets.cfg` 包含可在 Godot 中使用的两套预设。

Android 的 Min / Target SDK 留空，使用 Godot 4.7 官方模板自带的 API 24 / 36；预编译模板不允许覆写这两个选项。项目已启用导出所需的 ETC2/ASTC 纹理导入。

## 触发与下载

| 触发 | 行为 | 下载位置 |
| --- | --- | --- |
| 推送任意 tag | 测试并生成两个平台的包 | Actions → 对应运行 → `packages` artifact，保留 14 天 |
| 发布 Release / Pre-release | 测试、打包，并上传现有 Release 的附件 | Release 页面及该次 Actions 的 artifact |
| Actions → Run workflow | 对所选分支或 tag 手动测试、打包 | Actions artifact，不创建 Release |

使用 tag 的示例（先确保配置和需要打包的代码已推送）：

```sh
git tag v0.14.0
git push origin v0.14.0
```

也可以在 GitHub 的 Releases 页面选择 tag、填写说明并点击 Publish release。只保存草稿不会触发打包。发布预发布版本同样生效。工作流检出 tag 指向的代码，不会用后续 `main` 代码替代。

tag 推送后再发布同一 tag 的 Release，会触发两次独立构建；相同 tag 的运行按顺序执行。tag 构建只生成 artifact，不自动创建或发布 Release。Release 构建成功后上传 APK、ZIP、构建信息与校验值，重跑会替换同名附件。两种触发规则依据 [GitHub 的 push / release 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)。

下载包含：

- `ninja-must-die-<tag>-windows-x86_64.zip`：Windows 64 位 release 版，解压运行 `ninja-must-die.exe`；PCK 已嵌入 EXE，不依赖外置 Godot 或 .NET。
- `ninja-must-die-<tag>-android-debug.apk` 或 `...-android-release.apk`：包含 ARMv7 / ARM64，最低 Android 7.0 / API 24。
- `build-info.json`：tag、源码提交、Godot 版本、Android 模式 / versionCode 和对应 Actions 地址。
- `SHA256SUMS.txt`：APK、ZIP 和构建信息的 SHA-256 校验值。

tag 中的斜杠或特殊字符会转换为安全文件名并附加哈希，显示版本仍保留原 tag（去除开头的 `v`）。Android `versionCode` 使用该工作流的运行序号，正式更新须使用相同签名且更高 versionCode。

## Android 签名

没有配置签名 Secrets 时，工作流生成临时 debug keystore，产出可侧载安装的调试 APK，包名为 `io.github.invokerw.ninjamustdie.preview`。每次运行生成不同的调试签名；换装另一次运行的调试 APK 通常需卸载旧预览包，旧预览包的本地存档也会删除。预览包与正式包使用不同包名，可并存。

需要稳定签名、后续覆盖安装的正式 APK 时，在仓库 **Settings → Secrets and variables → Actions** 配置以下三个 Repository secrets；只配置一部分会明确失败：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 整个 release keystore 文件的 Base64 字符串 |
| `ANDROID_KEY_ALIAS` | keystore 中的密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码；Godot 要求 keystore 密码与密钥密码一致 |

三项齐全时自动改用 `--export-release`，正式包名为 `io.github.invokerw.ninjamustdie`。密钥仅在 runner 的临时目录解码，构建后删除，不进入仓库或下载产物。Godot 的签名环境变量和要求见 [Android 导出文档](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_android.html#environment-variables)。

如已有应用签名，应继续使用原签名。首次生成示例（在自己的机器执行并妥善保存原文件）：

```sh
keytool -genkeypair -v -keystore ninja-release.keystore -alias ninja \
  -keyalg RSA -keysize 2048 -validity 10000
```

Windows PowerShell 将文件转成 Base64 并复制到剪贴板的示例：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path ./ninja-release.keystore))) | Set-Clipboard
```

不要把 Base64 或密码写进工作流。签名 APK 适合直接分发；Google Play 的 AAB、商店上传、正式图标和 Windows 代码签名仍需另行配置，本工作流不发布到应用商店。

## 权限与诊断

构建 job 只有仓库读取权限，Release 上传 job 单独申请 `contents: write`，直接使用自动提供的 `GITHUB_TOKEN`，不需要额外 PAT。当前仓库 Actions 已启用。工作流使用固定提交版本的 Actions，Godot 官方下载校验 SHA-256；升级 Godot 时需一起更新脚本内版本 / 下载哈希、缓存键、模板目录与 SDK 要求。

必须先将工作流提交并推送到仓库，再推送包含该工作流的 tag 或发布其 Release；手动触发入口需要工作流已存在于默认分支。本地写入配置不会自动运行 GitHub 的构建。首次运行可在 [仓库 Actions 页面](https://github.com/invokerw/ninja-must-die/actions) 查看，失败时下载 `regression-logs` 或查看失败 step。

本地检查通过 Actions / Bash 语法、5 项元数据单元测试、十套 Godot 回归与跨进程存档检查；使用官方标准模板实际导出了 Windows release EXE，并验证了启动。

2026-10-25 已用 `gh workflow run` 完成[云端双平台构建验证](https://github.com/invokerw/ninja-must-die/actions/runs/40184806135)，源码提交为 `65ea43e`，构建 job 耗时 2 分 49 秒。回归、SDK 初始化、Windows release 导出、Android debug 导出、APK 签名校验与 artifact 上传均通过。下载产物后核对了全部 SHA-256，检查 APK 包含 ARMv7 / ARM64 库，并用云端生成的 Windows EXE 完成 120 帧无窗口启动检查，退出码为 0。

此轮使用手动触发，未发布测试 tag / Release；正式 Android keystore 签名、Release 附件上传及 Android 实机安装尚未实测。
