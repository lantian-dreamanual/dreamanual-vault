import kdbxwebModule from 'kdbxweb';
import { installArgon2 } from './lib/argon2-node.mjs';

const kdbxweb = kdbxwebModule.Kdbx ? kdbxwebModule : kdbxwebModule.default;
const { Kdbx, Credentials, ProtectedValue, VarDictionary, Consts } = kdbxweb;
installArgon2(kdbxweb);

const bv = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);

const creds = new Credentials(ProtectedValue.fromString('pw'));
const db = Kdbx.create(creds, 'probe');
const root = db.getDefaultGroup();

const fresh = db.createEntry(root);
console.log('fields 是 Map 吗        :', fresh.fields instanceof Map);
console.log('新条目已有字段 keys     :', fresh.fields instanceof Map ? [...fresh.fields.keys()] : Object.keys(fresh.fields));
console.log('typeof fields           :', Object.prototype.toString.call(fresh.fields));

const salt = kdbxweb.CryptoEngine.random(32);
db.setKdf(Consts.KdfId.Argon2id);
const p = db.header.kdfParameters;
p.set('S', VarDictionary.ValueType.Bytes, bv(salt));
p.set('P', VarDictionary.ValueType.UInt32, 4);
p.set('M', VarDictionary.ValueType.UInt32, 67108864);
p.set('I', VarDictionary.ValueType.UInt32, 3);
p.set('V', VarDictionary.ValueType.UInt32, 0x13);

// 用 Map.set 正确写入
fresh.fields.set('Title', '公司 VPN');
fresh.fields.set('UserName', 'demo.user');
fresh.fields.set('Password', ProtectedValue.fromString('Vpn!2026#Lab'));
fresh.fields.set('Notes', 'IP：192.0.2.40\n端口：2222');
fresh.times.update();

console.log('写入后 fields keys      :', [...fresh.fields.keys()]);

const buf = await db.save();
const re = await Kdbx.load(bv(new Uint8Array(buf)), creds);
const back = [...re.getDefaultGroup().allEntries()][0];

console.log('--- 读回 ---');
console.log('Title    =', JSON.stringify(back.fields.get('Title')));
console.log('UserName =', JSON.stringify(back.fields.get('UserName')));
const pw = back.fields.get('Password');
console.log('Password =', pw && pw.constructor && pw.constructor.name, '->', JSON.stringify(pw.getText ? pw.getText() : pw));
console.log('Notes    =', JSON.stringify(back.fields.get('Notes')));
console.log('cipher   =', re.header.dataCipherUuid.id === Consts.CipherId.Aes ? 'AES' : 'other');
