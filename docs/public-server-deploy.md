# 公网服务器部署说明

本项目现在支持由 Node 后端托管前端静态文件和 `/api/*` 接口。第三方 API Key 存在服务器 SQLite 中，不再由浏览器直接请求第三方服务。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `APP_PASSWORD` | 访问密码。公网部署必须设置强密码。 |
| `SESSION_SECRET` | Cookie 签名密钥。建议使用 32 字节以上随机字符串。 |
| `PORT` | Node 服务端口，默认 `3000`。 |
| `HOST` | 监听地址，默认 `0.0.0.0`。 |
| `DATA_DIR` | SQLite 和素材库目录，默认 `data`。 |
| `DIST_DIR` | 前端构建目录，默认 `dist`。 |
| `COOKIE_SECURE` | HTTPS 反代后建议设为 `true`。 |

## 本机运行

```bash
npm install
npm run build

APP_PASSWORD='替换为强密码' \
SESSION_SECRET='替换为随机长字符串' \
COOKIE_SECURE=true \
npm start
```

Windows PowerShell:

```powershell
$env:APP_PASSWORD="替换为强密码"
$env:SESSION_SECRET="替换为随机长字符串"
$env:COOKIE_SECURE="true"
npm start
```

## Docker

```bash
docker build -f deploy/Dockerfile -t gpt-image-playground .
docker run -d \
  --name gpt-image-playground \
  -p 3000:3000 \
  -v gpt-image-playground-data:/app/data \
  -e APP_PASSWORD='替换为强密码' \
  -e SESSION_SECRET='替换为随机长字符串' \
  -e COOKIE_SECURE=true \
  gpt-image-playground
```

## Nginx 反代示例

公网部署建议只暴露 HTTPS 域名，并由 Nginx/Caddy 反代到 Node 的 `127.0.0.1:3000`。

```nginx
server {
  listen 443 ssl http2;
  server_name example.com;

  client_max_body_size 80m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

## 初始化

1. 打开站点，输入 `APP_PASSWORD`。
2. 点击右上角“管理后台”。
3. 新增 API 配置，填写 API URL、API Key、模型，并设为当前配置。
4. 普通生成、Agent 图片生成、素材库上传和合成都使用同一个共享登录态。

## 安全注意

- 公网部署必须使用 HTTPS 和强密码。
- 不要把 `DATA_DIR` 暴露成静态目录；SQLite 和素材文件只应由后端接口访问。
- 定期备份 `DATA_DIR`，其中包含 API 配置和素材库。
- 当前版本是单密码共享模式，不区分用户，生成历史仍保存在各自浏览器本地。
