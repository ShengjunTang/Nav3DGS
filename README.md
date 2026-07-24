# GaussNav / Nav3DGS

浏览器端 3D Gaussian Splatting 实景导航工程编辑器。

## 在线使用

GitHub Pages：

<https://shengjuntang.github.io/Nav3DGS/>

网页无需登录。PLY 转 SOG、轨迹清洗、拓扑重构、POI 标记、导航规划和
`.gaussnav` 工程保存均在浏览器本地完成。

## 本地开发

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

验证 Sites 构建：

```bash
npm run build
```

验证 GitHub Pages 静态构建：

```bash
npm run build:pages
```

## GitHub Pages

推送到 `main` 后，`.github/workflows/pages.yml` 会自动构建并部署
`dist-pages`。

公开仓库不包含历史测试场景。使用者在网页内导入本机的 `.ply`、`.sog`
或 `.gaussnav` 文件，原始文件不会上传到服务器。
