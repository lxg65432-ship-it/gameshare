# 构建环境备忘（维护者机器踩坑实录）

> 这里记录的是**开发机特定**的环境坑。它们不代表所有人都会遇到，
> 但每一条都真实咬过人、排查成本高。按需参考。

## 1. `npm` 命令可能不可用

若 shell 里 `npm` 被拦截（沙箱 / 安全软件的 shim 层），改用解释器直调：

```bash
node "<node安装目录>/node_modules/npm/bin/npm-cli.js" install
```

仓库根的 `dev.bat` / `build-exe.bat` 已内置同样的回退逻辑：
`GAMESHARE_NODE_DIR` 环境变量可指定 node.exe 所在目录，否则从 PATH 探测。

## 2. npm 缓存与 Electron 二进制重定向到非系统盘（见根目录 `.npmrc`）

避免 C 盘被 Electron 的百余兆二进制撑满。换机器部署时按需改回。
`.npmrc` 里的 `electron_mirror` 与 `electron_builder_binaries_mirror` 都指向国内镜像，
直连 GitHub 一定失败，这两个不能删。

## 3. 打包必须显式锁死 electron 版本

npm workspaces 把 electron 提升到仓库根的 `node_modules`，而 electron-builder
只在本包目录里找 electron 模块，探不到就报
`Cannot compute electron version from installed node modules`。
所以 `apps/desktop/package.json` 的 `build.electronVersion` 必须写死版本，
升级 electron 时要同步改（`package.json` devDeps 与 `build.electronVersion` 两处）。
另外不要在 `build` 对象里写 `"//xxx"` 形式的注释键——
electron-builder 的配置 schema 会拒绝未知属性（顶层 `package.json` 的 `"//"` 才可以）。

## 4. 产物目录会被残留句柄锁住，`build-exe.mjs` 已自动绕开

每次 electron-builder 打包成功后，机器上都会留下一个持有
`<输出目录>/win-unpacked/resources/app.asar` 句柄的子进程。它本身已经退出，
`tasklist` 里查不到，但重命名和删除都报 `EPERM` / `EBUSY`，**要重启才释放**。
所以固定用 `release/` 的话，第二次打包必然卡在
`remove ...\app.asar: The process cannot access the file because it is being used by another process`
（历史上 `release2` / `release3` 就是这么攒出来的——不是「忘了关客户端」，
实测在没启动过任何客户端的情况下照样会锁）。
因此 `scripts/build-exe.mjs` 打包前会先探一次锁：`release` 被占就顺延
`release-2`、`release-3` …，打完再把安装包**复制**到 `release/`。
交付物永远在 `apps/desktop/release/GameShare Setup <版本>.exe`，
而 `release-N` 只是构建中间产物，重启后可以整个删掉。
手动指定目录：`node scripts/build-exe.mjs -c.directories.output=<目录>`。

## 5. `build.npmRebuild` 必须为 `false`

默认值下 electron-builder 会在 appDir 里跑 `npm install --production` 装生产依赖，
而 appDir（`apps/desktop`）是 npm workspace 的成员，npm 会把它当仓库根处理——
结果是根 `node_modules` 里的 devDependencies 被整体剪掉，
**包括 electron-builder 自己的 `app-builder-bin`**；紧接着打包就因为
`spawn ...\app-builder-bin\win\x64\app-builder.exe ENOENT` 崩掉。
日志里出现 `• installing production dependencies` 就是这一步开始的标志，
但它离最终报错隔了好几分钟，很容易误判成别的原因。
本项目主进程与渲染进程全部被打包、运行时零依赖、也没有原生模块要 rebuild，
这一步本来就不该存在。
万一又被剪了，`npm install` 可以恢复（实测约 6 分钟）。

## 6. electron-builder 的构建工具缓存要指向非系统盘，`build-exe.mjs` 已内置

它下载的 `winCodeSign` / `nsis` 默认放在 `%LOCALAPPDATA%\electron-builder\Cache`。
缓存不命中时它会去 `github.com` 下载 winCodeSign，而在 GitHub 直连不畅的环境
（如国内网络）会报 `winCodeSign-2.6.0.7z: Bad Gateway`——看着像网络问题，
其实只要让缓存命中就好了。
这条路**没法用配置解决**：`build.directories.cache` 会被 electron-builder 25.x 的
配置 schema 直接拒掉（`directories` 只认 `app` / `buildResources` / `output`），
写进 `.npmrc` 也无效（`builder-util` 只读 `process.env.ELECTRON_BUILDER_CACHE`，
没有 `npm_config_` 前缀的回退）——这一点和同一个 `.npmrc` 里的
`electron_config_cache` 行为不同，别类推。
唯一的办法是在启动 electron-builder 之前把环境变量设好，这就是
`scripts/build-exe.mjs` 存在的理由。绕过脚本直接调 electron-builder 就会踩这个坑。

## 7. 批处理文件（`.bat`）刻意不写任何中文

包括注释和 `echo` 出来的提示。批处理按控制台代码页解析，而本仓库路径本身含
非 ASCII 字符，文件里再出现非 ASCII 字面量有解析乱码的风险。
路径一律靠 `%~dp0` 在运行时推导。唯一的例外是 `diagnose-capture.bat`——
它先执行了 `chcp 65001` 切到 UTF-8 代码页。
