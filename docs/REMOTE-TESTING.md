# 跨网络连接测试指引

这份文档解决一个问题：**怎么验证两个人不在同一个网络时能不能用。**

结论先行，分三种情况（按可行性排序）：

| 情况 | 能不能用 | 需要什么 |
| --- | --- | --- |
| 双方都有公网 IPv6 | 能，且不需要 TURN | 路由器放行入站 |
| 至少一方是锥形 NAT | 大概率能 | 信令服务器放到公网可达的位置 |
| 一方是对称 NAT | 不能（要靠 TURN） | coturn 中继，属 M8 |

---

## 第 0 步：先诊断，别急着搬电脑

```bash
npm run check:network
```

这个脚本只用 Node 内置模块，可以直接拷到任何机器上跑。它回答三个问题：

1. 本机有没有公网 IPv6（唯一一条绕过 NAT 的路）
2. STUN 能不能拿到公网映射（拿不到就没有 srflx 候选）
3. NAT 是锥形还是对称（决定打洞有没有意义）

**换网络后要重跑。** 换 WiFi、换运营商、开关代理软件，结论都可能反过来。

### 开发机（2026-09-16 / 09-17）实测结果

```
公网 IPv6      2409:8xxx:xxxx:xxxx:...  ← 运营商下发，全球可达（两个地址，见下）
公网 IPv4      无（不是运营商 CGNAT，是本机是双层 NAT，见下）
NAT 类型       锥形（8 个样本 / 6 个网段，映射端口全部一致）
公网出口       203.0.113.10（RFC 5737 文档示例段，非真实地址）
```

三个重要发现：

- **本机是锥形 NAT**，映射与目标无关，打洞路线可行。
- **本机有公网 IPv6**，这是最省事的一条路。
- **实测环境在双层 NAT 后面**：路由器的 WAN 地址是内网地址（`192.168.1.2`），
  说明它上面还有一层光猫在路由。所以「在路由器上做个端口映射就能外网访问」
  这条路是走不通的——**要穿透两层**。

  ```bash
  # 查路由器自己认为的 WAN 地址（不需要登录路由器后台）
  #   → 返回 192.168.x.x 说明它上面还有一层 NAT
  #   → 返回 100.64.x.x 说明运营商做了 CGNAT
  #   → 返回公网地址     说明它直接挂在公网，端口映射可行
  ```

  实测的路由器支持 UPnP（UPnP IGD 服务在 `192.168.10.1`），但上一级光猫
  （`192.168.1.1`）没有 UPnP，所以自动开洞这条路也断了。
  真要端口映射，得在光猫和路由器上各配一条，且光猫的 WAN 必须是公网地址
  ——目前没有证据表明是。

**结论：双层 NAT 环境别折腾端口映射了。** 异地可达性走方案 D（隧道，已验证）
或方案 C（云主机）更省事。

### Chromium 侧 STUN 实测（同一时间）

Node 层能拿到公网映射，**不代表 Chromium 也能**——视频实际走的是 Chromium
自己的 ICE 实现，它有自己的 DNS 解析器和套接字。两者必须分开验：

```bash
npm run check:stun
```

| 节点 | 结果 |
| --- | --- |
| `stun.miwifi.com:3478` | ✓ 拿到 srflx（同时报 701，不影响） |
| `stun.chat.bilibili.com:3478` | ✓ 拿到 srflx（同时报 701，不影响） |
| `stun.hitv.com:3478` | ✓ 拿到 srflx，无报错 |
| `stun.qq.com:3478` | ✗ **拿不到 srflx** |
| `stun.l.google.com:19302` | ✓ 拿到 srflx |

**结论：Chromium 侧 STUN 可用，能拿到 srflx 候选（公网映射地址）。
异地打洞具备前提条件。**

两个反直觉的点，都值得记住：

1. **`code=701` 不是失败。** 原文是 `STUN host lookup received error`，
   属于 DNS 解析失败。同一个节点完全可能一边报 701 一边成功给出 srflx。
   判据只能是**能不能拿到 srflx 候选**，看有没有报错会得出完全相反的结论。
2. **Google 节点可用。** 与「国内一定不可达」的成见不符，实测 19302 端口是通的。

默认列表已按这份结果调整：移除了拿不到 srflx 的 `stun.qq.com`
（它在列表里既贡献 701 噪音又拖慢 ICE 收集），补入两个实测可用的国内节点。
增删节点前先跑 `npm run check:stun`，不要凭印象改。

> **关于「STUN 不可达」的历史记录**：早期版本记过「ICE 候选错误 701，STUN 不可达」。
> 那是**误判**。真实原因是本机代理软件把 Node 的 c-ares DNS
> 指向了 127.0.0.1 上并不存在的 DNS 服务，导致按域名解析全挂（`ECONNREFUSED`），
> 而直接对 IP 发 STUN 包是通的。系统解析器走网卡 DNS，不受影响。
> 这个区别很关键：前者要修环境，后者要换配置，方向完全相反。

---

## 第 1 步：决定信令服务器放哪

信令服务器负责牵线（交换 SDP 和 ICE 候选），牵完线视频就走 P2P 了。
所以它的**带宽要求极低**，但必须让双方都够得着。

### 方案 A：同一局域网（现状，不算异地）

信令服务器和两台机器都在一个路由器下。客户端内置的服务器默认就能干这个，
侧栏「本机信令服务」面板里会直接显示对方该填的地址。

**这不属于异地测试。** 两台机器在同一网段时会直接落在 host candidate 上，
测不到任何 NAT 相关的东西。

### 方案 B：公网 IPv6（零成本，但有前提，2026-09-17 实测对面不通）

本机有公网 IPv6 时，**客户端内置的服务器直接就能被外网访问**，不需要云主机，
不需要内网穿透。侧栏面板里「对方不在同一网络时填这个地址」那一栏就是它。

但注意：**这条路要求两边都有公网 IPv6 且两边都放行入站**，缺一边就废。

实测教训（2026-09-17）：本机两个公网 IPv6 地址本地全部 200 可达，
但另一台电脑的浏览器打开后报的是：

```
ERR_ADDRESS_INVALID
```

**这不是"连不上"，是那台机器连这个地址都无法使用。** 两者含义完全不同：

| 报错 | 含义 | 下一步 |
| --- | --- | --- |
| `ERR_ADDRESS_INVALID` | 客户端侧就没有可用的 IPv6（网卡无 IPv6、或被禁用） | 换方案，调路由器没用 |
| `ERR_CONNECTION_TIMED_OUT` | 有 IPv6，但入站被拦 | 去调路由器/光猫的 IPv6 防火墙 |
| `ERR_CONNECTION_REFUSED` | 包到了，但端口没人听 | 服务没起来，或端口映射指错了机器 |

所以遇到 `ERR_ADDRESS_INVALID` 时，先让对方在**关掉 WiFi** 的蜂窝网络下打开
`https://test-ipv6.com/`：拿不到 IPv6 地址就说明这条路在对方那侧就断了。

**产品层面的结论**：不能把"异地可用"建立在 IPv6 上。用户端有没有公网 IPv6
完全不可控，跨网络可用最终必须靠 TURN 中继兜底（M8）。

验证方法见第 2 步。

注意：家宽的 IPv6 前缀是动态的（重启光猫可能变），所以每次测试前重新看一眼面板。

### 方案 C：云服务器

最稳定，也最贵（轻量应用服务器约 ¥24～60/月）。

```bash
# 本地打包成单文件，产物自带所有依赖，服务器上不需要 npm install
npm run bundle:signaling
# → apps/signaling/dist/standalone/signaling-server.cjs

# 拷到服务器（只需要 Node ≥ 20）
scp apps/signaling/dist/standalone/signaling-server.cjs root@<服务器IP>:/opt/gameshare/

# 服务器上跑
PORT=8080 CORS_ORIGIN='*' node /opt/gameshare/signaling-server.cjs
```

要做的两件事：

1. **放行端口**：云服务器控制台的安全组里开 8080 的入站（TCP）。
2. **通知对方填**：`http://<服务器公网IP>:8080`。

> CORS 在客户端场景里其实是放开的（打包后的页面 Origin 是 `file://`），
> `CORS_ORIGIN='*'` 只是让独立服务也保持一致。这个服务不做鉴权，
> 别把房间码之外的东西放进去。

### 方案 D：内网穿透（当前最省事，2026-09-17 已验证可用）

不想买服务器、又想让对方连到自己本机时用这条路。**对面什么都不用装**，
只要在客户端的「信令服务器」里填一个 https 地址。

**现在不需要命令行了** —— 隧道已经做进客户端：

1. 启动客户端、进房间；
2. 「本机信令服务」面板里打开**「异地访问」**开关（**默认关闭**）；
3. 地址显示在界面上，点**「复制邀请」**把「信令地址 + 房间码」一次发给对方。

打包版自带 `cloudflared.exe`，**不用手动下载**。源码模式（`dev.bat`）才需要仓库里有
`tools/cloudflared.exe`。

下面是不走客户端、纯手工的老路径（`tunnel.bat` 等价于第 2 步）：

```bash
# 1) 下载 cloudflared（本机直连 github.com 会超时，用仓库里的下载脚本）
node scripts/fetch-github-release.mjs \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe \
  tools/cloudflared.exe

# 2) 起隧道（客户端要已经在跑，8080 在监听）
tools/cloudflared.exe tunnel --no-autoupdate --url http://localhost:8080
```

它会给一个 `https://xxx.trycloudflare.com` 地址，填进客户端即可。
**隧道只承载信令**（文本量极小），视频仍然走 WebRTC P2P，不受隧道带宽限制。

**验证隧道是否真的通了**（不要跳过，原因见下）：

```bash
npm run check:tunnel -- xxx.trycloudflare.com
```

cloudflared 日志里的 `Registered tunnel connection` **只说明它连上了 Cloudflare
边缘节点，不代表外网真能访问到本机 8080** —— 日志自己就写着
「it may take some time to be reachable」，地址刚生成时有一段沉默期。
不先验这一步，对面连不上时分不清是「隧道没通」还是「打洞失败」，两者解法完全不同。

实测证据（三轮，逐步加强）：

```
# ① 本机起隧道后从公网侧回访
Registered tunnel connection connIndex=0 ip=2606:4700:a8::5 location=sjc10 protocol=quic
外网 → /health       HTTP 200  {"ok":true,"service":"game-share-signaling",...}
外网 → socket.io     HTTP 200  0{"sid":"...","upgrades":["websocket"],...}

# ② 手机蜂窝网络（5G，关掉 WiFi）浏览器打开同一个地址
{"ok":true,"service":"game-share-signaling","protocolVersion":1,"rooms":0,"peers":0,"uptimeSec":154}
```

`upgrades:["websocket"]` 说明 WebSocket 升级通道是通的——这是客户端能不能用的关键。

**② 才是真正的结论**：手机蜂窝正是当初 IPv6 方案失败的场景
（`ERR_ADDRESS_INVALID`，对端没有 IPv6）。同一条路径换隧道就通了，
说明**问题从来不在客户端，也不在 IPv6 本身，而在入站可达性**。
隧道把「我们需要一个公网入口」这件事从「必须有 IPv6」降级成「随便有个能用的域名」。

> 手机浏览器可能弹「站点安全警告」一类的提示条。那是国内浏览器对临时域名
> （未备案 / 无历史信誉）的通用拦截策略，**不是证书问题** ——
> Cloudflare 签发的证书是有效的，连接是正常 TLS。
> 点「继续访问」即可，返回的 JSON 就是证据。客户端（Electron）不走浏览器 UI，
> 不受这个提示影响。

### 安全边界：给熟人用够不够？

这条路把信令服务暴露到公网，所以值得把风险讲清楚，而不是笼统说一句「注意安全」。

| 风险 | 实情 |
| --- | --- |
| 隧道地址被猜到 | **基本不可能**。域名是 4 个随机英文单词拼成的，且 `trycloudflare.com` 用通配符证书，子域名不进 Certificate Transparency 日志，没有地方可以枚举。 |
| 房间码被爆破 | **唯一实质性的弱点。** 6 位、字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` 共 32 个 = 10.7 亿组合，但服务端**完全没有限流**：`join-room` 失败只返回「房间不存在」，不限速、不封 IP、不记失败次数。 |
| 猜中房间码的后果 | **能直接看到共享画面。** `PeerLink` 的链路方向恒为 `sendrecv`，共享者正在共享时，任何加入房间的人都会立刻收到流。**没有二次确认，也没有踢人功能。** |
| 被陌生人占位 | 房间上限 4 人（`MAX_PEERS_PER_ROOM`），被占满后熟人进不来。 |
| Cloudflare 可见内容 | TLS 在 Cloudflare 边缘终止，信令内容（SDP、ICE 候选，含你的公网 IP）对它可见。视频是 P2P 端到端加密的，不经过它。熟人场景可接受。 |
| 谁都能用它开房间 | 无鉴权。服务无状态、房间自动回收，影响极小。 |

**结论：给熟人用，风险可接受，但要守住三条：**

1. **用完立刻关隧道窗口。** 这条最管用——爆破 10.7 亿个房间码要几个月，房间早关了。
   挂一天和挂五分钟，风险不是一个量级。
2. **房间码只在私聊里发**，别贴群里、别发朋友圈。房间码是唯一防线。
3. **别让隧道长时间挂着。** 它是验证工具，不是交付形态。

要补的缺口是 `join-room` 失败没有限速（同一 IP 每秒最多几次即可）。
更彻底的方案（服务端口令 / token 鉴权）属于 M8，那边本来就要做 coturn 和正式部署。
> 不适合长期挂着，也不适合当交付形态。

> 踩过的坑：直连 `github.com` TCP 能通但 TLS 之后就没数据；国内若干加速镜像
> （gh-proxy、ghproxy.net 等）TCP 通但同样卡死；免费 SSH 隧道
> （serveo.net / localhost.run / pinggy）三个的握手全被中途 reset。
> 剩下可行的是「直连非 github.com 的跳转域名」和「本机代理的 CONNECT 隧道」这两条，
> `fetch-github-release.mjs` 会依次试。Cloudflare 边缘本身完全可达
> （`region1/2.v2.argotunnel.com`、`api.trycloudflare.com` 都通）。

### 方案 E：先用组网软件把两个问题拆开（排查用，不是交付形态）

不方便买服务器、也不想折腾路由器和隧道时，用 ZeroTier / Tailscale / 蒲公英
这类工具把两台电脑拉进同一个虚拟局域网。

它的价值不是"能用"，而是**能定位**：装上之后，两个客户端在虚拟网卡上直接
处于同一网段，信令走内网地址必然可达，WebRTC 也会拿到虚拟网卡的 host candidate
直接连通。于是：

| 观察结果 | 说明什么 |
| --- | --- |
| 组网后能连上、能看到画面 | 协商逻辑、采集、编码、渲染全是好的 —— 问题 100% 出在**信令可达性**上，回去解决方案 B/C/D |
| 组网后仍然连不上 | 问题不在网络层，回去查客户端本身（这时才值得怀疑代码） |

**用它把变量消掉，然后立刻回到方案 B/C/D。** 别把它当成交付形态：
要求每个使用者都装第三方组网软件，对一个"朋友约着一起看画面"的产品来说太重了。

> 注意：组网工具自身的连通性也可能被同一个路由器防火墙拦住（有些走 UDP 打洞），
> 如果它自己也连不上，那说明路由器拦得比较彻底，直接跳到方案 C。

---

## 第 2 步：验证信令真的能被外网访问

**这一步必须在测 P2P 之前做。** 信令不通的话，后面所有失败都是它的锅，
你会误以为是打洞失败。

如果用方案 D（隧道），验证地址就是隧道窗口里那个 `https://xxx.trycloudflare.com`：

```
https://xxx.trycloudflare.com/health
```

**用手机蜂窝网络访问它**（关掉 WiFi，走 4G/5G）—— 这是最省事的验证方式，
因为隧道不依赖 IPv6，任何能上网的手机都行，**不需要等待另一台电脑到位**。
2026-09-17 实测通过。返回 JSON 就说明「信令已经能被外网访问」这一关过了，
剩下要验的只有 P2P 打洞。

如果用方案 B（公网 IPv6），**用手机蜂窝网络测**（不是 WiFi）：

1. 手机上**关掉 WiFi**，用 4G/5G（蜂窝网络基本都下发 IPv6）
2. 浏览器打开 `http://[面板里那个公网 IPv6 地址]:8080/health`

期望返回：

```json
{"ok":true,"service":"game-share-signaling","protocolVersion":1,"rooms":0,"peers":0,"uptimeSec":12}
```

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| 返回 JSON | 信令入站可达 ✅ | 进第 3 步 |
| 连接超时 | 被防火墙/路由器拦了 | 查路由器的 IPv6 防火墙、Windows 防火墙 |
| 连接被拒绝 | 服务没在跑，或端口不对 | 看侧栏面板状态 |
| `ERR_ADDRESS_INVALID` | 测的这一侧压根没有可用 IPv6 | 换方案 D 或 C |

> IPv6 地址在 URL 里**必须用方括号包裹**，写成 `http://[2409:xxxx::1]:8080`。
> 不加方括号的话冒号会被当成端口分隔符，浏览器直接报错。
> 面板里给的是可以直接复制的形式。
>
> **面板可能列出两个 IPv6 地址，给对方时挑「稳定」的那个。**
> Windows 默认同时启用隐私扩展，所以一块网卡会有两个公网 IPv6：
> 一个是**稳定地址**（`Get-NetIPAddress` 里 `SuffixOrigin=Link`），
> 一个是**临时地址**（`SuffixOrigin=Random`）—— 本机实测临时地址的
> `PreferredLifetime` 只有 **19 小时**，过期后自动换一个。
> 把临时地址给对方，他存下来明天就连不上了。判断方法见下一节。

### 手机蜂窝连不上时的分诊流程（2026-09-16 实测）

「手机连不上」有两种完全不同的原因，**先分诊再动手**，否则会在路由器里白折腾：

**① 手机蜂窝网络有没有 IPv6**（1 分钟，手机操作）

手机在蜂窝网络下（WiFi 关掉）访问 `https://test-ipv6.com/`。

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| 没有 IPv6 地址 | 这条路在手机侧就断了 | 别再调路由器，直接换方案 C / D |
| 有 IPv6 地址 | 手机侧没问题 | 进 ② |

**② 电脑这一侧有没有障碍**（电脑上跑，三条都要看）

```powershell
# 1) Windows 防火墙是不是真的在拦
#    注意：有实测机器是 Domain / Private / Public 三个 profile 全部 Enabled=False
#    （整个防火墙是关的）—— 这种情况下它不可能是元凶，别再围着它转
Get-NetFirewallProfile | Select-Object Name, Enabled

# 2) 公网 IPv6 地址的来源与寿命（区分稳定地址和临时地址）
Get-NetIPAddress -AddressFamily IPv6 |
  Select-Object IPAddress, InterfaceAlias, PrefixOrigin, SuffixOrigin, AddressState, PreferredLifetime

# 3) IPv6 默认路由在不在（不在说明路由器压根没下发 IPv6，那是另一类问题）
Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0'
```

同时确认**服务真的在自己所有地址上监听**（本机自连）：

```bash
# 起客户端后，把面板里的公网 IPv6 地址原样拿来访问自己
curl -g "http://[2409:xxxx:...]:8080/health"
```

本机实测：IPv4 回环、IPv6 回环、两个公网 IPv6、局域网 IPv4 —— 全部返回 200。
**注意这个测试的边界**：它走的是本机自身路由，只能排除「服务或系统这一层」的问题，
**不能证明外部能连进来**（那取决于路由器的 IPv6 防火墙）。

**③ 两条都排除后**，卡点才落到下面这一节。

### 如果 IPv6 被路由器拦了

按可能性排序：

1. **路由器 IPv6 防火墙**（最常见，也是开发机的实际卡点）。登录路由器，找
   「IPv6 防火墙」「IPv6 安全」或「IPv6 入站」一类的开关，关掉或加放行规则。
   部分光猫需要先改成桥接模式才能动这个设置。
2. **Windows 防火墙**。先用上面那条 `Get-NetFirewallProfile` 确认它到底开没开 ——
   **实测遇到过 Domain / Private / Public 三个 profile 全是 `Enabled=False` 的机器**，
   那台机器上它不可能是原因，别再围着它转。
   如果确实开着：首次启动客户端时弹窗点了「取消」就不会再弹，
   要去「Windows Defender 防火墙 → 允许应用通过防火墙」里手动补上，
   专用网络和公用网络都要勾。
3. **蜂窝网络侧**。少数运营商在移动网络上也限制 IPv6 入站，换一台手机验证。

如果路由器就是不放行（部分运营商定制固件不给这个选项），
退回方案 C 或 D。

---

## 第 3 步：测 P2P 打洞

前提：第 2 步已经通了。

1. 两台设备都开客户端，都连到**同一个**信令服务器地址
2. 一台建房，另一台用房间码进房
3. 一台点「枚举窗口 / 屏幕」选源开始共享
4. 看对方的画面有没有出来

### 怎么判断走的是 P2P 还是中继

读选中的 candidate pair：

```js
// Electron 渲染进程的 DevTools 控制台
const pc = /* 该项目里可从 window 上取到，或用下方命令行方式 */;
const stats = await pc.getStats();
for (const report of stats.values()) {
  if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
    const local = stats.get(report.localCandidateId);
    const remote = stats.get(report.remoteCandidateId);
    console.log(local.candidateType, '↔', remote.candidateType);
    console.log(local.address, ':', local.port, '→', remote.address, ':', remote.port);
  }
}
```

| `candidateType` | 含义 |
| --- | --- |
| `host` | 走的是本机地址。**跨网络时看到这个说明双方其实在同一网络** |
| `srflx` | STUN 打洞成功，真正的 P2P 直连 ✅ |
| `relay` | 走了 TURN 中继（M8 之后才有） |

**跨网络测试成功的样子是 `srflx`。**

> **实测记录（2026-09-17）：跨 NAT 已通过。** 异地电脑（另一个宽带、不同家）经
> Cloudflare 隧道连上信令后，正常看到本机共享的画面。没部署 TURN、host 候选又跨不了
> 公网，所以「能看到画面」等价于落在 `srflx`。
> **但当时没记路径标签** —— 这条是逻辑推断，别写成直接读数。下次复测时看一眼
> 瓦片底部那行，就能把它升格成证据。

> 当前版本还没做网络状态面板（M7），所以现在只能这样看。
> 如果看不到画面又没有任何报错，多半是打洞失败了：
> ICE 会持续尝试直到超时，界面上表现为「协商中」一直不动。

---

## 防火墙与端口速查

| 位置 | 要放行什么 |
| --- | --- |
| Windows 防火墙 | GameShare 首次启动时的弹窗点「允许访问」 |
| 路由器 IPv6 防火墙 | 8080/TCP 入站 |
| 云服务器安全组 | 8080/TCP 入站 |
| 光猫 | 若路由器在光猫后面，光猫也要能转发（多数情况桥接后不用管） |

---

## 已知限制

1. **对称 NAT 打不通。** 如果任一方是对称 NAT，P2P 直连无解，必须 TURN 中继（M8）。
   `npm run check:network` 能测出来。
2. **没有 TURN 兜底。** 打洞失败就是失败，没有降级路径。这是 M8 的工作。
3. **IPv6 前缀会变。** 家宽重启光猫后地址可能变，测试前重新看面板。
4. **不能指望对方有公网 IPv6。** 2026-09-17 实测，另一台电脑连 IPv6 地址都
   构造不出来（`ERR_ADDRESS_INVALID`）。异地可用性最终只能靠 TURN。
5. **不影响局域网使用。** 以上都是跨网络才会遇到的问题，同一路由器下照常。

---

## 相关命令

```bash
npm run check:network      # 本机 P2P 能力诊断（先跑这个）
npm run check:stun         # STUN 节点体检（Chromium 里能否拿到 srflx）
npm run check:standalone   # 验证独立部署产物能跑、且真的是双栈
npm run bundle:signaling   # 打包单文件信令服务，用于部署到公网机器
npm run serve              # 本机起独立信令服务并打印可达地址

# 下载 GitHub Release 产物（本机直连 github.com 会超时）
node scripts/fetch-github-release.mjs <url> <输出路径>
```

仓库根目录的三个 bat：

| 文件 | 用途 |
| --- | --- |
| `run.bat` | 启动最新的已打包客户端，不构建 |
| `dev.bat` | 从源码跑（Vite + Electron） |
| `tunnel.bat` | 起 Cloudflare 临时隧道，拿到给异地用的 https 地址 |
