/* kdbxweb 走 <script> 加载（原因见 src/vault/kdbx.ts 顶部注释），
   运行时是 window 上的一个全局对象，类型则从包自带的 d.ts 取。
   这样既拿到完整类型，又不把包交给打包器。 */

import type * as KdbxwebNs from 'kdbxweb';

declare global {
    interface Window {
        kdbxweb: typeof KdbxwebNs;
    }
}

export {};
