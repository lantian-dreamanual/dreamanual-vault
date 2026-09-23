/* 演示数据。只在开发标记下灌进库，正式运行时一行都不会被执行到。
 *
 * 这批数据的用途是让界面能被真实地看和点：分类计数、长名称截断、多行备注、
 * 中英文混排排序、搜索命中高亮 —— 这些都要有数据才能暴露问题。
 *
 * M1 时它是界面的唯一数据源；M2 接了真实 kdbx 之后降级成开发用具，
 * 由 `VAULT_DEV=seed` 触发（新建库时灌入），也是 500 条性能基准的底稿。
 *
 * 条目里的密码全是编造的示例值，不对应任何真实凭据。 */

import type { EntryInput } from '../vault/session';

function entry(
    group: string,
    title: string,
    userName: string,
    password: string,
    url: string,
    notes: string,
    _updatedAt: string
): EntryInput {
    return { group, title, userName, password, url, notes };
}

/** 演示用的分类。建库时除此之外还会自动有「未分类」 */
export const DEMO_GROUPS = ['服务器', '办公', '数据库', '云服务'];

export const DEMO_ENTRIES: EntryInput[] = [
        entry(
            '服务器',
            '公司 VPN',
            'demo.user',
            'Demo#Vpn-01',
            'vpn.example.com',
            '入口：vpn.example.com\n备用地址：203.0.113.9:443\n认证方式：域账号 + 短信二次验证\n\n注意：连续 3 次失败会锁 30 分钟，找 IT 解锁。',
            '2026-08-14'
        ),
        entry(
            '服务器',
            '堡垒机-生产',
            'demo.admin',
            'Demo#Jump-02',
            '192.0.2.11',
            'JumpServer 3.10\n地址：https://192.0.2.11\n端口：443 / SSH 转发 2222\n\n登录后先选资产组「生产环境」，再选具体机器。',
            '2026-09-02'
        ),
        entry(
            '服务器',
            '堡垒机-测试',
            'demo.admin',
            'Demo#Jump-03',
            '198.51.100.11',
            '测试环境，密码策略比生产松。\n同生产共用账号，但资产组选「测试环境」。',
            '2026-07-28'
        ),
        entry(
            '服务器',
            '跳板机-运维',
            'demo.ops',
            'Demo#Jump-04',
            '192.0.2.5',
            'ssh -p 2222 ops@192.0.2.5\n\n只做端口转发用，不要在跳板机上留文件。',
            '2026-06-19'
        ),
        entry(
            '服务器',
            'NAS 管理后台',
            'demo.user',
            'Demo#Nas-05',
            '192.0.2.20:5000',
            'DS923+，DSM 7.2\n局域网：192.0.2.20:5000\n外网：走 QuickConnect\n\n备份任务：每日 02:00 增量，每周日完整。',
            '2026-09-10'
        ),
        entry(
            '服务器',
            '路由器-主',
            'admin',
            'Demo#Router-06',
            '192.0.2.1',
            '华硕 AX6000\n固件：3.0.0.4.388\n\n改过端口转发：2222 → NAS、8096 → Jellyfin。',
            '2026-05-30'
        ),
        entry(
            '服务器',
            'Jenkins 构建机',
            'demo.build',
            'Demo#Build-07',
            'http://198.51.100.30:8080',
            '只跑前端打包与镜像构建。\n凭据都配在 Jenkins 里，账号本身很少用。',
            '2026-08-06'
        ),

        entry(
            '办公',
            '企业邮箱',
            'demo@example.com',
            'Demo#Mail-08',
            'mail.example.com',
            'Exchange，开启了两步验证。\nIMAP：993 SSL / SMTP：465 SSL\n客户端授权码与登录密码不同，授权码单独存在手机里。',
            '2026-09-15'
        ),
        entry(
            '办公',
            'OA 系统',
            'demo.user',
            'Demo#Oa-09',
            'oa.example.com',
            '请假、报销、采购都走这里。\n审批流：直属主管 → 部门 → 财务。',
            '2026-09-08'
        ),
        entry(
            '办公',
            '企业微信管理后台',
            'demo.user',
            'Demo#Work-10',
            'work.weixin.qq.com',
            '管理员账号，能改通讯录与应用可见范围。\n改之前先在测试企业里试。',
            '2026-07-11'
        ),
        entry(
            '办公',
            '钉钉-部门管理员',
            '138****0000',
            'Demo#Ding-11',
            'dingtalk.com',
            '只用于部门考勤例外处理。',
            '2026-04-22'
        ),
        entry(
            '办公',
            '打印机后台',
            'admin',
            '12345678',
            '192.0.2.88',
            '默认密码一直没改，本身也在内网，暂不动。',
            '2026-03-15'
        ),
        entry(
            '办公',
            '会议室投屏码',
            '—',
            '0000',
            '—',
            '3 号会议室电视的投屏 PIN。\n换过一次，现在是 8821。',
            '2026-02-09'
        ),

        entry(
            '数据库',
            '生产库-MySQL',
            'demo_app',
            'Demo#Db-13',
            '192.0.2.21:3306',
            '库名：vault_prod\n连接：mysql -h 192.0.2.21 -P 3306 -u vault_app -p\n\n⚠️ 只读账号，写操作走另一套。别在这里跑 DDL。',
            '2026-09-12'
        ),
        entry(
            '数据库',
            '生产库-Redis',
            'default',
            'Demo#Db-14',
            '192.0.2.22:6379',
            '无密码直连会失败，需要 AUTH。\n只用于会话缓存，丢了不影响业务。',
            '2026-06-25'
        ),
        entry(
            '数据库',
            '测试库-PostgreSQL',
            'postgres',
            'Demo#Db-15',
            '198.51.100.21:5432',
            'psql -h 198.51.100.21 -U postgres -d vault_test\n\n每天 03:00 从生产脱敏同步。',
            '2026-08-19'
        ),
        entry(
            '数据库',
            'MongoDB-日志库',
            'demo_logger',
            'Demo#Db-16',
            '192.0.2.23:27017',
            '存 Nginx 访问日志，保留 90 天。\n数据量大，查询记得加时间范围。',
            '2026-05-12'
        ),

        entry(
            '云服务',
            '腾讯云-主账号',
            'demo-cloud',
            'Demo#Cloud-17',
            'console.cloud.tencent.com',
            '账号 ID：1000xxxxxxx\n绑定了 MFA（手机）。\n\n⚠️ 主账号只用来开子账号，日常操作一律用子账号。',
            '2026-09-18'
        ),
        entry(
            '云服务',
            '腾讯云-运维子账号',
            'demo-ops@example.com',
            'Demo#Cloud-18',
            'console.cloud.tencent.com',
            '权限：CVM 只读 + 快照 + 监控。\n生产服务器：203.0.113.18（nginx 1.20.1）',
            '2026-09-18'
        ),
        entry(
            '云服务',
            '备案系统',
            'demo-cloud',
            'Demo#Beian-19',
            'beian.miit.gov.cn',
            'ICP 备案用户名。\n续期在到期前 30 天做，逾期会掉备案。',
            '2026-01-20'
        ),
        entry(
            '云服务',
            '域名注册商',
            'demo-cloud',
            'Demo#Domain-20',
            'console.dns.com',
            'example.com 就在这里。\n到期：2027-03-11\n自动续费已开。',
            '2026-03-11'
        ),
        entry(
            '云服务',
            'Cloudflare',
            'demo@example.com',
            'Demo#Cf-21',
            'dash.cloudflare.com',
            '只做 DNS 与 CDN，不开代理的域名记得把橙云点灰。',
            '2026-09-05'
        ),
        entry(
            '云服务',
            'Let\'s Encrypt 证书管理器',
            '—',
            '—',
            'localhost:8080',
            'certbot 装在服务器上，不是网页账号。\n续期：sudo certbot renew --dry-run\n证书目录：/etc/letsencrypt/live/example.com/',
            '2026-08-27'
        ),

        entry(
            '未分类',
            'GitHub',
            'demo-gh',
            'Demo#Git-22',
            'github.com',
            '开了 2FA（TOTP）。\n恢复码在 1Password 之外的纸质备份里。\n\n私有仓库：github.com/example-org/example-repo',
            '2026-09-19'
        ),
        entry(
            '未分类',
            'Figma',
            'demo@example.com',
            'Demo#Figma-23',
            'figma.com',
            '团队版，成员 3 人。\n设计系统文件在团队里，改主色前先同步。',
            '2026-09-01'
        ),
        entry(
            '未分类',
            'WordPress 后台',
            'demo-cloud',
            'Demo#Wp-24',
            'blog.example.com/wp-admin',
            '只跑博客。\n已装插件：Dreamanual AI Tag Optimizer、Dreamanual Toolkit。\n主题：twentytwentyfive 子主题。',
            '2026-09-16'
        ),
        entry(
            '未分类',
            'Jellyfin',
            'demo.user',
            'Demo#Jf-25',
            'http://192.0.2.20:8096',
            '媒体库挂在 NAS 上。\n剧集路径：/volume1/media/\n转码建议关掉，直接用原画质。',
            '2026-08-30'
        ),
        entry(
            '未分类',
            'Eagle 素材库',
            '—',
            '—',
            '—',
            '本地素材库，无账号。\n（演示条目，不含真实路径。）。',
            '2026-08-21'
        ),
        entry(
            '未分类',
            '微信公众平台',
            'demo-cloud',
            'Demo#Mp-26',
            'mp.weixin.qq.com',
            '只用来发文章，没开留言。\n素材库容量已经用了 60%。',
            '2026-07-03'
        )
];
