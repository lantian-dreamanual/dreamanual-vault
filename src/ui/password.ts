/* 密码本身的判断与生成。
 *
 * 这三个函数原先分居两个视图（`passwordScore` / `randomPassword` 在 vault.ts、
 * `weaknessOf` 在 unlock.ts），而它们服务的是四处界面：解锁页的强度条、主视图的
 * 生成按钮、编辑弹窗的强度条、设置页的改主密码。放在 `ui/` 下是为了让最后那一处
 * 不必从另一个视图里 import —— 密码策略只有一份，弱密码词表也只有一份。
 *
 * 这一层不碰 DOM，也不碰加密库。 */

/** 生成一串随机密码。去除易混字符（l/1/I、0/O），符号集够宽但不含引号与反斜杠，
 *  免得粘进命令行或配置文件时被转义。 */
const PW_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';

export function randomPassword(length = 20): string {
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < length; i += 1) out += PW_ALPHABET[bytes[i]! % PW_ALPHABET.length];
    return out;
}

/** 粗略强度：长度 + 字符集种类。**这一档是提示性的**，界面只用它给条颜色
 *  （弱 / 中 / 强三格），不参与任何判断 —— 主密码与条目密码都是用户自己的选择。
 *  真要做熵估算，得配上字典与模式识别，而那是另一件事。 */
export function passwordScore(pw: string): { level: 0 | 1 | 2 | 3; color: string } {
    if (!pw) return { level: 0, color: 'transparent' };
    let kinds = 0;
    if (/[a-z]/.test(pw)) kinds += 1;
    if (/[A-Z]/.test(pw)) kinds += 1;
    if (/[0-9]/.test(pw)) kinds += 1;
    if (/[^a-zA-Z0-9]/.test(pw)) kinds += 1;

    const raw = pw.length + kinds * 4;
    if (raw < 16) return { level: 1, color: 'var(--danger)' };
    // 中档以前是一个写在 JS 里的琥珀色字面值，对着 --panel 只有 2.94:1。改走
    // --warn 之后由令牌决定色值，spike/contrast.mjs 守着它
    // （它会把 tokens.css 之外的字面色值全部拦下）。
    if (raw < 26) return { level: 2, color: 'var(--warn)' };
    return { level: 3, color: 'var(--ok)' };
}

/** 弱密码提示词表。主密码与条目密码共用一份 —— 两处各维护一张表迟早会分叉。 */
const COMMON_WORDS = ['password', '123456', 'qwerty', 'admin', 'letmein', 'iloveyou', 'welcome', 'abc123'];

/** 弱密码提示。**只警告不阻止**（PRD §4.3）—— 拦下来更像是找麻烦，而主密码是
 *  用户自己要记住的一串，替他做决定没有意义。返回 null 表示没意见。 */
export function weaknessOf(password: string): string | null {
    if (password.length < 12) return `只有 ${password.length} 位，建议 12 位以上`;
    const lower = password.toLowerCase();
    const hit = COMMON_WORDS.find((word) => lower.includes(word));
    if (hit) return `包含常见词「${hit}」，容易被猜到`;
    if (/^(.)\1+$/.test(password)) return '全部是同一个字符';
    return null;
}
