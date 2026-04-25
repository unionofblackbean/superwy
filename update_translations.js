const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const db = new Database('inventory.db');

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    name_zh TEXT,
    count INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS scan_status (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'idle',
    progress REAL DEFAULT 0,
    current_pos TEXT
  );
`);

/**
 * 从 list.csv 加载本地化翻译
 */
function loadLocalTranslations() {
    const translationMap = new Map();
    try {
        if (!fs.existsSync('list.csv')) {
            console.warn('[警告] 未找到 list.csv，将使用默认 ID 显示。');
            return translationMap;
        }

        const content = fs.readFileSync('list.csv', 'utf8');
        const lines = content.split(/\r?\n/);

        lines.forEach(line => {
            if (!line || line.trim() === '') return;
            // 格式: id, en_us, zh_cn
            const parts = line.split(',');
            if (parts.length >= 3) {
                const id = parts[0].trim();
                const zh = parts[2].trim();
                if (id && zh) {
                    translationMap.set(id, zh);
                }
            }
        });
        console.log(`[本地化] 已从 list.csv 加载 ${translationMap.size} 条翻译。`);
    } catch (err) {
        console.error('[本地化错误] 读取 list.csv 失败:', err.message);
    }
    return translationMap;
}

/**
 * 核心：同步物品与翻译到数据库
 */
function syncDatabase() {
    const translationMap = loadLocalTranslations();
    const insertItem = db.prepare(`
        INSERT INTO inventory (id, name_zh) 
        VALUES (?, ?) 
        ON CONFLICT(id) DO UPDATE SET name_zh = excluded.name_zh
    `);

    // 1. 读取你的库存模版文件 main_storage_itemscsv.txt
    try {
        if (fs.existsSync('main_storage_itemscsv.txt')) {
            const templateContent = fs.readFileSync('main_storage_itemscsv.txt', 'utf8');
            const lines = templateContent.split(/\r?\n/);

            const transaction = db.transaction((items) => {
                for (const itemId of items) {
                    const fullId = itemId.startsWith('minecraft:') ? itemId : `minecraft:${itemId}`;
                    const rawId = itemId.replace('minecraft:', '');
                    // 匹配 list.csv 中的中文，找不到则用 ID 兜底
                    const nameZh = translationMap.get(rawId) || rawId;
                    insertItem.run(fullId, nameZh);
                }
            });

            const itemsToSync = lines
                .map(l => l.split(',')[0].trim())
                .filter(id => id && id !== 'ID');

            transaction(itemsToSync);
            console.log(`[数据库] 已同步 ${itemsToSync.length} 个物品的翻译。`);
        }
    } catch (err) {
        console.error('[数据库错误] 同步模版失败:', err.message);
    }
}

// 初始化执行
db.prepare("INSERT OR IGNORE INTO scan_status (id, status) VALUES ('global', 'idle')").run();
syncDatabase();

module.exports = db;