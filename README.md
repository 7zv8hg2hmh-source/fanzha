# 上当模拟器 · 你能带着多少钱离场？

> 高校沉浸式反诈教育闯关小游戏。让学生在"想赢、想继续、想回本"的真实心理机制中走完一遍，结算页才点醒——这不是宣传册，是一台"上头机制展示器"。

## 项目结构

```
fraud-game/
├── package.json        # 仅 3 个依赖：express / sqlite3 / body-parser
├── server.js           # Express + SQLite，本地 API 与统计
├── game.db             # 首次运行自动创建
├── supabase/
│   ├── schema.sql               # 推荐：Supabase 数据表
│   ├── config.toml              # 推荐：公开 Edge Function 配置
│   └── functions/fraud-game-api # 推荐：Supabase 共享统计 API
├── .github/workflows/pages.yml  # GitHub Pages 自动部署
└── public/
    ├── config.js       # 共享统计 API 地址配置
    ├── index.html      # GitHub Pages 入口，跳转到 game.html
    ├── 404.html        # 静态路由兜底
    ├── screen/index.html # 大屏静态入口
    ├── qr/             # 可打印/投屏扫码的本地 SVG 二维码
    └── game.html       # 单文件前端，含 10 关 + 回血 + 统计大屏
```

## 本地运行（30 秒上手）

环境要求：Node.js ≥ 14（推荐 18+）

```bash
cd fraud-game
npm install
node server.js
```

启动后会看到：

```
╔═══════════════════════════════════════╗
║  上当模拟器 已启动                     ║
║  http://localhost:3000                ║
║  大屏: http://localhost:3000/screen   ║
║  扫码进指定关: ?level=1 ... ?level=10  ║
╚═══════════════════════════════════════╝
```

### 访问路径

| URL | 用途 |
|---|---|
| `http://localhost:3000` | 主入口，欢迎页 → 菜单 → 关卡 |
| `http://localhost:3000/?level=1` | 扫码直达第 1 关（自动建会话） |
| `http://localhost:3000/?level=10` | 扫码直达"神秘内测" |
| `http://localhost:3000/screen` | 大屏页，5 秒自动刷新，适合活动现场投屏 |

### 端口与环境变量

```bash
PORT=8080 node server.js   # 自定义端口
```

## GitHub Pages 部署

这个项目可以直接部署到 GitHub Pages。推送到 GitHub 后，在仓库设置里进入 **Settings → Pages**，Source 选择 **GitHub Actions**。之后每次推送到 `main` 或 `master`，`.github/workflows/pages.yml` 会把 `public/` 发布成静态站点。

### Pages 访问路径

| URL | 用途 |
|---|---|
| `https://你的用户名.github.io/仓库名/` | 主入口，会自动跳到 `game.html` |
| `https://你的用户名.github.io/仓库名/game.html?level=1` | 扫码直达第 1 关 |
| `https://你的用户名.github.io/仓库名/screen/` | 统计大屏 |
| `https://你的用户名.github.io/仓库名/game.html?screen=1` | 统计大屏备用入口 |
| `https://你的用户名.github.io/仓库名/qr/` | 可打印二维码总览 |

### 共享统计怎么处理

GitHub Pages 只能托管 HTML/CSS/JS，不能运行 Node、SQLite 或 `/api/*`。项目里保留两种统计模式：

1. **零配置静态模式**：直接上 Pages 就能玩，在线人数、访问量和各关游玩人次保存在当前浏览器的 `localStorage`。适合演示、单机投屏、课堂预览。
2. **共享统计模式（推荐 Supabase）**：把 `supabase/functions/fraud-game-api` 部署成 Supabase Edge Function，并运行 `supabase/schema.sql` 建表。然后在 `public/config.js` 设置：

```js
window.FG_API_BASE = 'https://你的项目.supabase.co/functions/v1/fraud-game-api';
```

这样前端继续放在 GitHub Pages，当前在线人数、总访问量、今日访问量和各游戏游玩人次走 Supabase Edge Function + Postgres，多个手机扫码后会看到同一份统计数据。

### Supabase 快速接入（推荐）

1. 在 Supabase 新建一个项目。
2. 打开项目的 **SQL Editor**，把 `supabase/schema.sql` 粘进去运行一次。
3. 本地登录并部署 Edge Function：

```bash
npm install supabase --save-dev
npx supabase login
cd fraud-game
npx supabase link --project-ref 你的项目ref
npx supabase functions deploy fraud-game-api --no-verify-jwt
```

4. 把函数地址写入 `public/config.js`：

```js
window.FG_API_BASE = 'https://你的项目ref.supabase.co/functions/v1/fraud-game-api';
```

5. 推送到 GitHub，Pages 自动部署后就是共享统计。

> 注意：不要把 Supabase `service_role` key 写进 `public/` 前端文件。这个项目的 Edge Function 会在 Supabase 服务端使用 `SUPABASE_SERVICE_ROLE_KEY`，浏览器只知道公开函数地址。

## 云服务器部署（生产环境）

### 方案 A：最简单 —— pm2 + 直连端口

适合：内部活动、无域名、临时使用。

```bash
# 1. 安装 Node 18 (以 Ubuntu 为例)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs git

# 2. 上传项目
scp -r fraud-game user@your-server:/opt/

# 3. 安装依赖
cd /opt/fraud-game
npm install --production

# 4. 用 pm2 守护
sudo npm i -g pm2
pm2 start server.js --name fraud-game
pm2 save && pm2 startup
```

打开服务器防火墙 3000 端口后，直接 `http://你的IP:3000` 就能访问。

### 方案 B：nginx 反向代理 + HTTPS（推荐）

适合：对外宣传、长期使用、需要 https（微信内置浏览器要求）。

**安装并配置 nginx：**

```bash
sudo apt install -y nginx

# /etc/nginx/sites-available/fraud-game
server {
    listen 80;
    server_name fanzha.your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/fraud-game /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**加 HTTPS（用 certbot 一键搞定）：**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d fanzha.your-domain.com
```

之后 `https://fanzha.your-domain.com` 直接用，证书自动续期。

### 方案 C：国内备案场景

阿里云 / 腾讯云轻量服务器都行，部署流程同方案 B。**注意**：

1. 域名必须备案，否则 80/443 端口被运营商拦截。
2. 微信内置浏览器在国内必须用 https，否则会拦截 + 给警告。
3. 安全组放行 80/443，3000 端口可以不放行（让它只监听 127.0.0.1）。

## 二维码生成

项目已经内置了一套本地 SVG 二维码，在 GitHub Pages 上访问：

```
https://7zv8hg2hmh-source.github.io/fanzha/qr/
```

这些二维码不依赖第三方生成服务，适合直接打印、投屏、贴海报。注意：如果二维码显示在同一台手机屏幕上，手机摄像头当然没法扫自己屏幕；这种场景请直接点页面里的按钮/链接，或把二维码投屏/打印出来扫码。

**手动生成**（活动海报用）：

直接用任意二维码生成工具（草料、QR Code Generator）输入：

```
https://fanzha.your-domain.com
https://fanzha.your-domain.com/?level=1
https://fanzha.your-domain.com/?level=10
```

生成 N 张二维码贴在不同位置，每张对应一个关卡入口——学生扫到哪个就先玩哪个。

**命令行批量生成**（部署在服务器上的话）：

```bash
sudo apt install -y qrencode
for i in $(seq 1 10); do
  qrencode -o "qr-level-$i.png" -s 8 "https://fanzha.your-domain.com/?level=$i"
done
qrencode -o qr-screen.png -s 8 "https://fanzha.your-domain.com/screen"
qrencode -o qr-main.png   -s 8 "https://fanzha.your-domain.com"
```

10 张关卡码 + 1 张大屏码 + 1 张主入口码，活动一次性发完。

## 数据管理

### 数据存储位置

所有数据在 `fraud-game/game.db`（SQLite 单文件），重启不丢。

### 备份

```bash
cp game.db game.db.$(date +%Y%m%d_%H%M).bak
```

### 清空所有数据（仅本地管理）

```bash
curl -X POST http://localhost:3000/api/reset \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"YES_RESET"}'
```

或直接删除 db 文件后重启：

```bash
rm game.db && pm2 restart fraud-game
```

### 导出统计数据

```bash
sqlite3 game.db ".mode csv" ".output level-plays.csv" \
  "SELECT level_id, COUNT(*) AS plays
   FROM level_plays GROUP BY level_id ORDER BY level_id;"

sqlite3 game.db ".mode csv" ".output visits.csv" \
  "SELECT visit_date, COUNT(*) AS visits
   FROM visits GROUP BY visit_date ORDER BY visit_date;"
```

## 安全与伦理边界（已硬编码到产品）

> 这些不是声明，是代码层面强制的设计：

1. **无真实支付通道**——所有金额都是 SQLite 里的整数字段。
2. **无真实赌博/投资接口**——所有"中奖""暴涨""空投"都是前端伪造的视觉效果。
3. **不保存任何真实敏感信息**——用户输入的"学号""手机号""验证码"在前端 confirm 框出现后就被丢弃，永远不会进入数据库。
4. **匿名 sessionId**——`sx_` + 16 位随机字节，与任何真实身份系统都不挂钩。
5. **页面常驻水印**——底部"模拟教学 · 无真实资金交易"在所有视图都不会消失。
6. **数据可一键删除**——单文件 SQLite，活动结束直接删 db 文件即可。

## 关卡架构（开发者参考）

10 关全部定义在 `public/game.html` 中的 `LEVELS` 数组与 `LEVEL_RENDERERS` 对象。

**完整版（多步状态机 + 完整心理机制）**：1, 2, 3, 4, 7, 8, 9, 10

**简化版（2-3 步可运行版本）**：5, 6

简化版结构是完整的——每关有自己的 step、levelData、render、handler 函数，要扩成完整版只需在对应 `LEVEL_RENDERERS[N]` 里增加 step 分支即可，不用动其他任何代码。

### 添加自定义关卡

1. 在 `LEVELS` 数组追加 `{id, title, subtitle, difficulty}`
2. 在 `LEVEL_RENDERERS` 中加 `LEVEL_RENDERERS[21] = function() {...}`
3. 把 step 转换函数挂到 `window.levelXxx`
4. 关卡内调用 `recordTrap({...})` 和 `changeMoney(...)` 即自动写入数据库

### 心理机制总表（设计参考）

游戏中已实现的 tactic（心理机制）：

`差点中奖 / 小额甜头 / 沉没成本 / 提现门槛 / 概率操控 / 回本冲动 / 连胜错觉 / 攀比刺激 / 临门一脚 / 裂变诱导 / 信息核验 / 二次解冻 / 规则黑箱 / 注意力剥夺 / 借贷加码 / 假买家 / 荐股诈骗 / 权限滥用 / 稀有奖励 / 好胜心理 / 网络赌博`

每个 tactic 在 `TACTIC_EXPLANATION` 字典里有对应的结算页揭示文案，要新增一个机制就加一行。

## 活动现场建议

1. **大屏摆中央**：投屏 `/screen`，让 100 人的实时事件流滚起来，自带气氛。
2. **二维码梯度部署**：从食堂、宿舍楼到图书馆贴不同关卡的码——同学扫不同的码进入不同关卡，自然形成"我在玩 5 关，他在玩 17 关"的话题。
3. **结算页可截图分享**：诊断书的 S/A/B/C/D/E 评级是社交货币，鼓励学生自发传播。
4. **不要预热说"反诈宣传"**：海报标题就是"你能带着多少钱离场？"，把"反诈教育"四个字藏到结算页之后。

## 反诈中心专线

游戏结束页持续显示：**96110**（国家反诈中心 24 小时专线）

如果在使用过程中有学生反馈自己曾真实遭遇相似骗局，请立即引导其拨打 96110 或就近报案。

## License

MIT —— 任何高校、班级、社团均可自由使用、修改、二次开发。

如果做出了好玩的版本，欢迎在源码里署上你的学校名。
