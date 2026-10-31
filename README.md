# storage

云端文件中转站 —— 打开网页拖拽上传，任何设备随时下载，**无需注册、无需令牌**。

## 在线地址

**https://polytrack114514.github.io/storage/**

## 怎么用

1. 打开上面的网址
2. 把文件拖进「上传文件」区域（也可点「选择文件」或「选择整个文件夹」）
3. 文件会直接提交到本仓库，并出现在「云端文件」列表里
4. 换任何设备打开同一网址，都能看到并下载

支持多文件、整个文件夹上传，可指定目标子目录，带进度条和逐文件状态提示。全部文件操作都通过云端中转服务完成，网页本身不保存、不接触任何 GitHub 令牌。

## 架构

```
浏览器（GitHub Pages 页面）
        │  POST /upload  /delete    GET /list  /download
        ▼
Cloudflare Pages 后端  https://file-cloud-share.pages.dev
        │  携带 GitHub 令牌
        ▼
GitHub 仓库 polytrack114514/storage
```

- 前端：本仓库 `index.html`，由 GitHub Pages 托管
- 后端：Cloudflare Pages 上的 `_worker.js`，持有 GitHub 令牌，对外提供上传/删除/列表/下载接口
- 前端通过仓库里的 `backend.json` 得知后端地址，当前为：

```json
{ "workerUrl": "https://file-cloud-share.pages.dev", "password": "" }
```

后端已部署完成，日常使用无需再做任何配置。若日后需要重新部署，把 `worker.js` 作为 `_worker.js` 上传到 Cloudflare Pages 项目，并配置环境变量即可。当前值：

| 变量 | 值 |
| --- | --- |
| `GH_TOKEN` | 加密变量，GitHub 令牌（不对外暴露） |
| `REPO_OWNER` | `polytrack114514` |
| `REPO_NAME` | `storage` |
| `BRANCH` | `main` |
| `ALLOW_ORIGIN` | `*` |

## 保护机制

`backend.json`、`index.html`、`README.md` 这三个基础文件受**后端强制保护**：

- 任何覆盖或删除请求，后端一律返回 `403`，即使绕过网页直接调用接口也无效
- 上传同名文件会被后端拒绝并提示，不会破坏站点
- 页面上额外标记为「不可删除」并隐藏删除按钮，上传时自动跳过

这三层中，前两端（后端拒绝）才是真正的保护，前端标记只是让人看得见。

## 说明

- 本仓库是**公开仓库**，上传的文件任何人都能看到，请勿存放敏感内容
- 单文件最大 100 MB，前端与后端双重校验，后端超限直接返回 `413`
- 子目录中的同名文件不受保护（只有仓库根目录的三个基础文件受保护）
- 如果不想让陌生人随意上传，可在后端设置 `UPLOAD_PASSWORD`，并把同样的口令填进 `backend.json` 的 `password` 字段。注意 `backend.json` 本身公开可读，这个口令只能算轻度门槛
- 适合文档、图片、代码等小文件，不适合当网盘存放大量大文件

## 仓库文件

| 文件 | 说明 |
| --- | --- |
| `index.html` | 上传器页面（GitHub Pages 托管） |
| `backend.json` | 上传后端地址配置 |
| `worker.js` | 后端源码（令牌保存于云端环境变量，不在代码里） |
| `README.md` | 本说明 |
