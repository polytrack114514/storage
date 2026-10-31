# file-cloud-storage

云端文件存储仓库 —— 用于把任意电脑上的文件上传到云端，随时查看和下载。

## 用途

- 在一台电脑上传文件
- 在另一台电脑或手机浏览器上查看
- 需要时下载回本地

## 上传文件（在有文件的电脑上）

```bash
git clone https://github.com/polytrack114514/file-cloud-storage.git
cd file-cloud-storage
# 把你的文件复制进来
git add .
git commit -m "upload: 描述一下这次上传了什么"
git push
```

## 下载文件（在任何设备上）

```bash
git clone https://github.com/polytrack114514/file-cloud-storage.git
# 或已经克隆过：
git pull
```

也可以直接在浏览器打开仓库页面，点击文件后使用右上角的下载按钮。

## 目录建议

```
file-cloud-storage/
├── docs/        # 文档
├── images/      # 图片
├── backup/      # 备份文件
└── misc/        # 其他
```

## 注意事项

- 单个文件建议不超过 100 MB（GitHub 单文件硬限制）
- 超过 50 MB 的文件建议使用 Git LFS
- 公开仓库任何人都能查看，敏感文件请勿上传，或把仓库改为私有
