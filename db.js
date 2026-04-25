const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('inventory.db');

// 初始化表结构
// 注意：使用反引号包裹多行 SQL 字符串
db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    name_zh TEXT,
    count INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS item_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT,
    chest_x INTEGER,
    chest_y INTEGER,
    chest_z INTEGER,
    count INTEGER,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES inventory(id)
  );
  
  CREATE TABLE IF NOT EXISTS scan_status (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'idle',
    progress REAL DEFAULT 0,
    current_pos TEXT,
    current_area_name TEXT,
    scan_areas TEXT DEFAULT '',
    scan_speed INTEGER DEFAULT 20
  );
  
  CREATE TABLE IF NOT EXISTS container_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_x INTEGER,
    container_y INTEGER,
    container_z INTEGER,
    item_id TEXT,
    item_name_zh TEXT,
    count INTEGER,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES inventory(id),
    UNIQUE(container_x, container_y, container_z)
  );

  -- 将已有容器记录的 count 字段规范为该容器内的总库存数量
  UPDATE container_items
  SET count = COALESCE((
    SELECT SUM(count)
    FROM item_locations
    WHERE chest_x = container_items.container_x
      AND chest_y = container_items.container_y
      AND chest_z = container_items.container_z
  ), 0);
`);

// 检查并添加缺失的列（用于数据库升级）
try {
    db.prepare("SELECT scan_areas FROM scan_status LIMIT 1").get();
} catch (err) {
    if (err.message.includes('no such column')) {
        console.log('[数据库] 添加缺失的 scan_areas 列...');
        db.exec('ALTER TABLE scan_status ADD COLUMN scan_areas TEXT DEFAULT \'\'');
    }
}

try {
    db.prepare("SELECT scan_speed FROM scan_status LIMIT 1").get();
} catch (err) {
    if (err.message.includes('no such column')) {
        console.log('[数据库] 添加缺失的 scan_speed 列...');
        db.exec('ALTER TABLE scan_status ADD COLUMN scan_speed INTEGER DEFAULT 20');
    }
}

/**
 * 从 list.csv 加载本地化翻译
 */
function loadLocalTranslations() {
    const translationMap = new Map();
    try {
        if (!fs.existsSync('list.csv')) return translationMap;
        const content = fs.readFileSync('list.csv', 'utf8');
        const lines = content.split(/\r?\n/);
        lines.forEach(line => {
            if (!line || line.trim() === '') return;
            const parts = line.split(',');
            if (parts.length >= 3) {
                const id = parts[0].trim();
                const zh = parts[2].trim();
                if (id && zh) translationMap.set(id, zh);
            }
        });
    } catch (err) {
        console.error('[本地化错误]', err.message);
    }
    return translationMap;
}

/**
 * 同步数据库内容
 */
function syncDatabase() {
    const translationMap = loadLocalTranslations();
    const insertItem = db.prepare(`
        INSERT INTO inventory (id, name_zh) 
        VALUES (?, ?) 
        ON CONFLICT(id) DO UPDATE SET name_zh = excluded.name_zh
    `);

    try {
        if (fs.existsSync('main_storage_itemscsv.txt')) {
            const templateContent = fs.readFileSync('main_storage_itemscsv.txt', 'utf8');
            const lines = templateContent.split(/\r?\n/);
            const itemsToSync = lines
                .map(l => l.split(',')[0].trim())
                .filter(id => id && id !== 'ID');

            const transaction = db.transaction((ids) => {
                for (const itemId of ids) {
                    const fullId = itemId.startsWith('minecraft:') ? itemId : `minecraft:${itemId}`;
                    const rawId = itemId.replace('minecraft:', '');
                    const nameZh = translationMap.get(rawId) || rawId;
                    insertItem.run(fullId, nameZh);
                }
            });
            transaction(itemsToSync);
        }
    } catch (err) {
        console.error('[同步失败]', err.message);
    }
}

// 确保初始状态存在
db.prepare("INSERT OR IGNORE INTO scan_status (id, status) VALUES ('global', 'idle')").run();
syncDatabase();

module.exports = db;