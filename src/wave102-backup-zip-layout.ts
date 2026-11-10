/** Same STORED/UTF8/descriptor ZIP64 representation as backup-zip.ts.
 * PKWARE APPNOTE6.3.10 §§4.3.9,4.3.12,4.3.14,4.5.3. */
const u16=(n:number)=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b}
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b}
const u64=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid ZIP64 value');const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b}
export function localWave102(name:Buffer,size:number){return Buffer.concat([u32(0x04034b50),u16(45),u16(0x0808),u16(0),u16(0),u16(0),u32(0),u32(0xffffffff),u32(0xffffffff),u16(name.length),u16(20),name,u16(1),u16(16),u64(size),u64(size)])}
export function descriptorWave102(size:number,crc:number){return Buffer.concat([u32(0x08074b50),u32(crc),u64(size),u64(size)])}
export function centralWave102(name:Buffer,size:number,crc:number,offset:number){return Buffer.concat([u32(0x02014b50),u16(45),u16(45),u16(0x0808),u16(0),u16(0),u16(0),u32(crc),u32(0xffffffff),u32(0xffffffff),u16(name.length),u16(28),u16(0),u16(0),u16(0),u32(0),u32(0xffffffff),name,u16(1),u16(24),u64(size),u64(size),u64(offset)])}
export function endWave102(count:number,centralOffset:number,centralBytes:number){return Buffer.concat([u32(0x06064b50),u64(44),u16(45),u16(45),u32(0),u32(0),u64(count),u64(count),u64(centralBytes),u64(centralOffset),u32(0x07064b50),u32(0),u64(centralOffset+centralBytes),u32(1),u32(0x06054b50),u16(0),u16(0),u16(0xffff),u16(0xffff),u32(0xffffffff),u32(0xffffffff),u16(0)])}
