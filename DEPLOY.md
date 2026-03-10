# 部署说明（同一台服务器）

---

## 若 LLM API key 曾泄露：立即操作

1. **在 OpenAI 控制台立刻 revoke/rotate 已泄露的 key**，并检查 usage / 设置 spending limits，否则泄露的 key 仍可被滥用。
2. **线上禁止用 `npm start` 对外服务**。必须使用 `npm run build` 后由 nginx 提供 `build/` 静态文件；否则开发构建会把环境变量打进前端，且会暴露 WebSocket/HMR。

---

## Nginx 正确转发：详细步骤（按顺序做）

### 步骤 1：确认 nginx 已安装并找到配置文件位置

在服务器上执行：

```bash
# 看 nginx 是否在跑
sudo systemctl status nginx

# 看主配置文件路径（通常是下面之一）
ls -la /etc/nginx/nginx.conf
ls -la /etc/nginx/sites-enabled/
```

- **主配置**：`/etc/nginx/nginx.conf`（会 `include` 其它文件）
- **站点配置**：一般在 `/etc/nginx/sites-enabled/` 下，每个文件一个或多个 `server { ... }`；也可能在 `/etc/nginx/conf.d/*.conf`

### 步骤 2：找到你站点对应的 server 配置

你的域名是 `virtranoteapp.sci.utah.edu`，要编辑**包含这个域名的 server 块**所在的文件。

```bash
# 在 sites-enabled 里搜 server_name
sudo grep -r "virtranoteapp\|server_name" /etc/nginx/sites-enabled/

# 或在 conf.d 里搜
sudo grep -r "virtranoteapp\|server_name" /etc/nginx/conf.d/
```

记下包含 `server_name virtranoteapp.sci.utah.edu`（或类似）的**那个文件的完整路径**，例如：

- `/etc/nginx/sites-enabled/virtranoteapp`  
或  
- `/etc/nginx/conf.d/virtranoteapp.conf`

下面用 `配置文件路径` 代替，你替换成实际路径。

### 步骤 3：备份并打开该配置文件

```bash
# 备份（把 配置文件路径 换成你步骤 2 得到的路径）
sudo cp /etc/nginx/sites-enabled/你的站点文件 /etc/nginx/sites-enabled/你的站点文件.bak

# 用编辑器打开（需要 sudo）
sudo nano /etc/nginx/sites-enabled/你的站点文件
# 或
sudo vim /etc/nginx/sites-enabled/你的站点文件
```

### 步骤 4：确认/设置站点根目录（前端 build）

在**同一个** `server { ... }` 块里（有 `listen 443 ssl` 和 `server_name virtranoteapp.sci.utah.edu` 的那段），确认有：

```nginx
root /实际项目路径/GanttSketch/build;
index index.html;
```

例如项目在 `/var/www/GanttSketch`，就写：

```nginx
root /var/www/GanttSketch/build;
index index.html;
```

如果还没有 `location / { ... }`，在 `server { }` 里加上：

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

### 步骤 5：在同一个 server 块里加入两个转发

在**同一个** `server { }` 内、**不要**写在 `location /` 的里面，在它**后面**追加下面两段。

**5.1 数据接口：/get-events → 8080**

```nginx
    location /get-events {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

**5.1.1 手动上传接口（新增）：/health、/api/upload-trace、/api/clear-trace → 8080**

如果你使用 `scripts/nsight_raw_data_server.py` 的**手动上传模式**（前端检测到后端在跑但没 trace 时提示你上传），需要再加下面三段转发到 8080：

```nginx
    location /health {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/upload-trace {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 2g;   # 视你的 trace 大小调整
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location /api/clear-trace {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

**5.2 Export 接口：/api/export-anywidget → 8090**

```nginx
    location /api/export-anywidget {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 600s;
    }
```

**5.3 LLM 代理（Server Proxy）：/api/llm/ → 8091**

用于保护 LLM API key：key 只存在服务器环境变量中，前端请求 `/api/llm/` 时不带 key，由本机 8091 服务加上 key 后转发到 OpenAI。SSE 流式响应需关闭缓冲并加长超时。公网部署建议对 `/api/llm/` 做限流（按 IP），避免被刷额度。

在 **http** 块中（如 `/etc/nginx/nginx.conf` 的 `http { ... }` 内）添加限流 zone（与其它 server 共用一次即可）：

```nginx
    limit_req_zone $binary_remote_addr zone=llm:10m rate=2r/s;
```

在 **同一 server 块**内添加：

```nginx
    location /api/llm/ {
        limit_req zone=llm burst=5 nodelay;
        proxy_pass http://127.0.0.1:8091;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
    }
```

服务器上需运行 LLM 代理并配置 key，例如：

```bash
export OPENAI_API_KEY=sk-your-key-here
npm run llm:server
```

或用 systemd 常驻，并设置 `Environment=OPENAI_API_KEY=...`。本机可用 `curl -s http://127.0.0.1:8091/health` 验证。

**整体结构示例**（只做参考，重点是上面两个 `location` 和 `root` 在同一 `server` 里）：

```nginx
server {
    listen 443 ssl;
    server_name virtranoteapp.sci.utah.edu;
    root /var/www/GanttSketch/build;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /get-events {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/upload-trace {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 2g;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location /api/clear-trace {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/export-anywidget {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 600s;
    }

    location /api/llm/ {
        limit_req zone=llm burst=5 nodelay;
        proxy_pass http://127.0.0.1:8091;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
    }

    # 你原有的 ssl_certificate、ssl_certificate_key 等保持不变
    # ssl_certificate ...
    # ssl_certificate_key ...
}
```

保存并退出（nano: Ctrl+O 回车，Ctrl+X；vim: `:wq`）。

### 步骤 6：检查配置并重载 nginx

```bash
# 测试语法（有任何报错都要先改掉）
sudo nginx -t

# 若显示 "syntax is ok" 和 "test is successful"，再重载
sudo systemctl reload nginx
```

若 `nginx -t` 报错，会提示哪一行有问题，回到步骤 3 修改对应文件后再执行步骤 6。

### 步骤 7：确认后端在监听（否则会 502）

```bash
# 数据后端（端口按你实际改，这里是 8080）
curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080/get-events?begin=0&end=1000&bins=10"
# 能通一般会返回 200 或你的接口实际状态码

# export 服务（8090）
curl -s http://127.0.0.1:8090/health
# 应返回 {"ok":true,"running":false}
```

如果 8090 连不上，先在同一台机上运行：

```bash
cd /实际项目路径/GanttSketch
export EXPORT_SERVER_ALLOWED_ORIGINS=https://virtranoteapp.sci.utah.edu
npm run export:server
```

再用 `curl -s http://127.0.0.1:8090/health` 验证，最后在浏览器里再试一次导出。

### 步骤 8：从外网自测

在你自己电脑上：

- 打开 `https://virtranoteapp.sci.utah.edu`
- 看页面是否正常、数据是否加载（会请求 `/get-events`）
- 点导出，看是否还 502；若仍 502，回步骤 7 确认 8090 进程和 `curl 127.0.0.1:8090/health`。

---

## 其余说明（原部署说明）

线上必须用 **生产构建**，不要用 `npm start`。否则会出现：
- `WebSocket connection to 'wss://...:3000/ws' failed`（开发环境的 HMR）
- `react-dom.development.js` 等开发包被加载

## 1. 用生产构建提供前端

在服务器上构建并只提供静态文件，不要跑开发服务器：

```bash
npm ci
npm run build
```

用 nginx（或其它 Web 服务器）把站点根目录指到 **build 目录**，例如：

```nginx
server {
    listen 443 ssl;
    server_name virtranoteapp.sci.utah.edu;
    root /path/to/GanttSketch/build;   # 重要：是 build/ 不是项目根
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    # 下面第 2、3 步会用到
    # location /get-events { ... }
    # location /api/export-anywidget { ... }
}
```

这样用户访问的是打包后的静态资源，没有 WebSocket/HMR，也不会再连到 3000 端口。

## 2. 数据接口 /get-events

在 nginx 里把 `/get-events` 转到你的数据后端（例如 8080）：

```nginx
location /get-events {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 3. Export 接口 /api/export-anywidget（解决 502）

502 表示 nginx 收到了请求，但转给后端时失败（后端没跑或端口不对）。

**3.1 在服务器上常驻运行 export 服务**

```bash
cd /path/to/GanttSketch
# 允许线上域名调用
export EXPORT_SERVER_ALLOWED_ORIGINS=https://virtranoteapp.sci.utah.edu
npm run export:server
```

用 systemd/supervisor 等保持进程常驻，例如：

```ini
# /etc/systemd/system/gantt-export.service
[Unit]
Description=GanttSketch export server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/GanttSketch
Environment=EXPORT_SERVER_ALLOWED_ORIGINS=https://virtranoteapp.sci.utah.edu
ExecStart=/usr/bin/npm run export:server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

**3.2 在 nginx 里把 /api/export-anywidget 转到 8090**

```nginx
location /api/export-anywidget {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    proxy_connect_timeout 10s;
    proxy_send_timeout 600s;
}
```

**3.3 确认本机能访问 export 服务**

在服务器上执行：

```bash
curl -s http://127.0.0.1:8090/health
# 应返回 {"ok":true,"running":false}
```

若连不上，说明 export 进程没在 8090 监听，请先保证 `npm run export:server` 在跑再重载 nginx。

## 4. 小结

| 现象 | 原因 | 处理 |
|------|------|------|
| WebSocket `:3000/ws` failed | 用了开发构建 (npm start) | 改为 `npm run build` 并用 nginx 提供 `build/` |
| POST /api/export-anywidget 502 | nginx 转发的后端未启动或端口错 | 在服务器跑 `npm run export:server`，nginx 代理到 127.0.0.1:8090 |
| 后端完全没收到请求 | 502 时请求已被 nginx 收到，未到 Node | 先在本机 `curl 127.0.0.1:8090/health` 确认进程在跑，再检查 nginx 的 proxy_pass 和端口 |
