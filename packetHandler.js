const nbt = require('prismarine-nbt');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

async function handleServuxPacket(data) {
    // Sakura Servux Packet 结构: [ID (1b)] [Compressed (1b)] [Total (2b)] [Index (2b)] [Data...]
    const packetId = data.readInt8(0);
    const isCompressed = data.readInt8(1) === 1;
    
    // 如果是 0x05 (Inventory Data)，开始尝试解析
    if (packetId === 0x05 || packetId === 0x06) {
        let payload = data.slice(6); // 跳过头部
        
        try {
            if (isCompressed) {
                payload = await gunzip(payload);
            }
            const { parsed } = await nbt.parse(payload);
            return parsed;
        } catch (e) {
            console.error('NBT 解析失败，可能是分片数据不完整:', e.message);
            return null;
        }
    }
    return null;
}

module.exports = { handleServuxPacket };