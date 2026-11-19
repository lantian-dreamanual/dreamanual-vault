/* 错误文案的最后一道分流。
 *
 * 界面只摆本项目写好的中文句：状态、原因、下一步动作都写全，用户照着能做。
 * 宿主 IPC、kdbxweb、文件插件抛上来的是引擎报错、绝对路径、字段名、HTTP 状态，
 * 摆到界面上用户没法照着做，原文交给 reportError 落日志，界面给一句固定中文。
 *
 * 判定按来源和文字形态：本项目写给界面的句子都抛 Error 实例、句子里有中文，
 * 中间允许夹用户自己起的名字（分类名、条目名可能是英文，也可能是年份）。
 * 宿主 IPC 与文件插件抛上来的通常是字符串原文，以 ASCII 为主；带路径、网址、
 * 模板残片、十六进制或字段键名的一律按技术串处理。VaultFormatError 与
 * WrongPasswordError 是本项目自己定义的界面错误，按类型直接放行。 */

import { reportError } from '../host';
import { VaultFormatError, WrongPasswordError } from '../vault/session';

const FALLBACK = '应用内部调用失败，请重试';

/** 技术原文。给日志、验收读数、自检报告用，不要摆到界面上。 */
export function errorDetail(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function writtenForUser(err: unknown, detail: string): boolean {
    if (err instanceof VaultFormatError || err instanceof WrongPasswordError) return true;
    const chinese = (detail.match(/[\u3400-\u9fff]/g) ?? []).length;
    if (!chinese) return false;
    // 路径、网址、模板残片、十六进制与字段键名是技术串的形状，
    // 写给用户看的句子里不会出现
    if (/[\\/]|https?:|\$\{|\.js\b|\.kdbx\b|0x[0-9a-fA-F]{2,}|\b[a-z]+_[a-z]+\b/.test(detail)) return false;
    // Error 实例是本项目自己抛的；宿主原文多为字符串，只有以中文为主的固定句才放行
    if (err instanceof Error) return true;
    return chinese * 5 >= detail.replace(/\s/g, '').length * 2;
}

/** 界面上的一句。原文若不是写给用户看的，先进日志再换固定中文。 */
export function userFacingError(err: unknown): string {
    const detail = errorDetail(err);
    if (writtenForUser(err, detail)) return detail;
    reportError(`[错误链] 未收口的技术原文：${detail}`);
    return FALLBACK;
}
