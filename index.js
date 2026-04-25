const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');
const scanner = require('./scan');
const { setupChatListener } = require('./chat');
const { parseLitematica, compareMaterialsWithInventory } = require('./litematica');
const multer = require('multer');
const taskQueue = require('./taskQueue');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

taskQueue.on('change', (state) => {
    io.emit('task_queue_update', state);
});

process.on('uncaughtException', (err) => {
    console.error('\x1b[41m%s\x1b[0m', '[致命错误] 进程未捕获异常:', err.message);
    // 这里不退出进程，让断线重连逻辑继续生效
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[异步错误] 未处理的 Rejection:', reason);
});
// 初始化 Bot
scanner.initBot();

let lastBoundBot = null;
function bindBotListeners(bot) {
    if (!bot || bot === lastBoundBot) return;

    setupChatListener(bot, {
        onGG: (username) => {
            console.log(`\x1b[36m%s\x1b[0m`, `[聊天] 玩家 ${username} 触发了!!gg指令`);
            if (scanner.keepalive) {
                scanner.keepalive.testRestockGG().catch(err => {
                    console.error('[错误] !!gg指令执行失败:', err.message);
                });
            } else {
                console.log('\x1b[31m%s\x1b[0m', '[错误] 保活模块未初始化');
            }
        }
    });

    lastBoundBot = bot;
    console.log('\x1b[36m%s\x1b[0m', '[聊天模块] 已绑定到当前 Bot 实例');
}

// 初次绑定 + 重连后自动重绑
bindBotListeners(scanner.bot);
setInterval(() => bindBotListeners(scanner.bot), 2000);

// 检查之前的扫描状态，如果有断点就保留
const lastStatus = db.prepare("SELECT * FROM scan_status WHERE id = 'global'").get();
if (!lastStatus) {
    // 第一次运行，创建初始记录
    db.prepare("INSERT INTO scan_status (id, status) VALUES (?, ?)").run('global', 'idle');
} else if (lastStatus.status === 'scanning') {
    // 如果上次状态是 scanning，改为 paused，因为程序已重启
    console.log('\x1b[33m%s\x1b[0m', '[系统] 检测到上次扫描状态为"scanning"，已改为"paused"，等待用户手动续扫');
    db.prepare("UPDATE scan_status SET status = 'paused' WHERE id = 'global'").run();
}

io.on('connection', (socket) => {
    console.log('控制台已连接');
    
    // 实时推送数据库内容
    const syncData = () => {
    // 按照数量降序排列，同时确保所有预载入的 0 库存物品也能查出来
    const items = db.prepare(`
        SELECT i.id, i.name_zh, i.count, 
               GROUP_CONCAT(il.chest_x || ',' || il.chest_y || ',' || il.chest_z || ':' || il.count) as locations
        FROM inventory i
        LEFT JOIN item_locations il ON i.id = il.item_id
        GROUP BY i.id
        ORDER BY i.count DESC, i.id ASC
    `).all();
    
    const status = db.prepare("SELECT * FROM scan_status WHERE id = 'global'").get();
    socket.emit('sync', { items, status, taskQueue: taskQueue.getState() });
};

    const timer = setInterval(syncData, 1000);

    socket.on('command_scan', (mode) => {
        let areas;
        if (mode === 'all') {
            areas = Object.keys(require('./config').areas);
        } else if (Array.isArray(mode)) {
            // 如果是数组，直接使用
            areas = mode;
        } else if (typeof mode === 'string') {
            // 如果是字符串，包装成数组
            areas = [mode];
        } else {
            console.error('[系统] 无效的扫描模式:', mode);
            return;
        }
        // 异步执行扫描，不阻塞 Web 线程
        scanner.startFullScan(areas);
    });

    socket.on('command_force_rescan', () => {
        // 清空所有库存数据
        db.prepare("DELETE FROM inventory").run();
        db.prepare("DELETE FROM item_locations").run();
        db.prepare("DELETE FROM container_items").run();
        console.log('\x1b[33m%s\x1b[0m', '[系统] 库存数据已清空，准备启动强制重扫...');
        
        // 重置扫描进度
        db.prepare("UPDATE scan_status SET status = 'scanning', progress = 0, current_pos = '', current_area_name = '准备扫描' WHERE id = 'global'").run();
        
        // 启动全连扫任务
        const areas = Object.keys(require('./config').areas);
        scanner.startFullScan(areas);
    });

    socket.on('command_stop_scan', () => {
        console.log('\x1b[33m%s\x1b[0m', '[系统] 收到停止扫描指令');
        scanner.stopScan();
    });

    socket.on('command_stop_task_queue', () => {
        console.log('\x1b[33m%s\x1b[0m', '[系统] 收到终止任务队列指令');
        taskQueue.terminateAll('由前端手动终止');
    });

    socket.on('command_set_scan_speed', (speed) => {
        const parsedSpeed = Number(speed);
        if (Number.isNaN(parsedSpeed) || parsedSpeed < 1 || parsedSpeed > 1000) {
            socket.emit('scan_speed_response', { success: false, error: '扫描速度必须在 1 到 1000 ms 之间' });
            return;
        }
        scanner.setScanSpeed(parsedSpeed);
        db.prepare("UPDATE scan_status SET scan_speed = ? WHERE id = 'global'").run(parsedSpeed);
        socket.emit('scan_speed_response', { success: true, scan_speed: parsedSpeed });
    });

    socket.on('command_resume_scan', () => {
        console.log('\x1b[33m%s\x1b[0m', '[系统] 收到续扫指令');
        const status = db.prepare("SELECT * FROM scan_status WHERE id = 'global'").get();
        if (status && status.status === 'paused') {
            // 从暂停状态恢复
            db.prepare("UPDATE scan_status SET status = 'scanning' WHERE id = 'global'").run();
            scanner.resumeScan();
        } else {
            console.warn('[系统] 无法续扫：不在暂停状态');
        }
    });

    socket.on('disconnect', () => clearInterval(timer));
});

// API: 获取物品的容器位置
app.get('/api/container-locations/:itemId', (req, res) => {
    try {
        const itemId = req.params.itemId;
        const fullItemId = itemId.startsWith('minecraft:') ? itemId : `minecraft:${itemId}`;
        
        // 查询该物品在哪些容器中
        const containers = db.prepare(`
            SELECT container_x, container_y, container_z, item_name_zh, count
            FROM container_items
            WHERE item_id = ?
            ORDER BY container_y DESC, container_z ASC, container_x ASC
        `).all(fullItemId);
        
        res.json({ success: true, containers });
    } catch (error) {
        console.error('[API错误]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/container-map', (req, res) => {
    try {
        const containers = db.prepare(`
            SELECT container_x, container_y, container_z, item_id, item_name_zh, count
            FROM container_items
            ORDER BY container_y DESC, container_z ASC, container_x ASC
        `).all();
        res.json({ success: true, containers });
    } catch (error) {
        console.error('[API错误]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 配置 multer 用于文件上传
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const fs = require('fs');
            if (!fs.existsSync('uploads')) {
                fs.mkdirSync('uploads', { recursive: true });
            }
            cb(null, 'uploads/');
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + path.extname(file.originalname));
        }
    }),
    fileFilter: (req, file, cb) => {
        // 只允许 .litematic 文件
        if (path.extname(file.originalname).toLowerCase() === '.litematic') {
            cb(null, true);
        } else {
            cb(new Error('只支持 .litematic 文件'));
        }
    }
});

// Litematica 文件分析端点
app.post('/api/litematica', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '未选择文件' });
        }

        const currentFilePath = req.file.path;
        const currentFileName = req.file.filename;
        
        console.log('[Litematica] 开始解析文件:', req.file.originalname);

        // 清理 uploads 文件夹中的旧文件（排除当前文件）
        const uploadsDir = 'uploads';
        if (fs.existsSync(uploadsDir)) {
            const files = fs.readdirSync(uploadsDir);
            for (const file of files) {
                // 跳过当前上传的文件
                if (file === currentFileName) {
                    continue;
                }
                
                const filePathToDelete = path.join(uploadsDir, file);
                try {
                    fs.unlinkSync(filePathToDelete);
                    console.log(`[清理] 删除旧文件: ${file}`);
                } catch (err) {
                    console.warn(`[警告] 无法删除文件 ${file}:`, err.message);
                }
            }
        }

        // 解析 Litematica 文件
        const parseResult = await parseLitematica(currentFilePath);
        
        if (parseResult.error) {
            throw new Error(parseResult.error);
        }

        // 将 Map 转换为对象
        const requiredMaterials = {};
        for (const [material, count] of parseResult.materials) {
            requiredMaterials[material] = count;
        }

        // 获取当前库存
        const inventoryData = db.prepare("SELECT id, name_zh, count FROM inventory").all();
        
        // 对比库存
        const comparison = compareMaterialsWithInventory(parseResult.materials, inventoryData);

        // 给比较结果添加中文名称
        const addChineseNames = (items) => {
            return items.map(item => {
                const inv = inventoryData.find(i => i.id === `minecraft:${item.material}`);
                return {
                    ...item,
                    name_zh: inv ? inv.name_zh : item.material,
                    name_en: item.material
                };
            });
        };

        // 删除上传的临时文件
        try {
            fs.unlinkSync(currentFilePath);
            console.log(`[清理] 已删除上传的临时文件`);
        } catch (err) {
            console.warn(`[警告] 无法删除临时文件:`, err.message);
        }

        res.json({
            success: true,
            metadata: {
                name: parseResult.metadata.Name || '未命名项目',
                author: parseResult.metadata.Author || '',
                time_created: parseResult.metadata.TimeCreated || 0,
                time_modified: parseResult.metadata.TimeModified || 0,
                total_blocks: parseResult.metadata.TotalBlocks || 0
            },
            materials: requiredMaterials,
            comparison: {
                sufficient: addChineseNames(comparison.sufficient),
                insufficient: addChineseNames(comparison.insufficient),
                missing: addChineseNames(comparison.missing)
            },
            summary: {
                totalTypes: Object.keys(requiredMaterials).length,
                sufficient: comparison.sufficient.length,
                insufficient: comparison.insufficient.length,
                missing: comparison.missing.length
            }
        });
    } catch (error) {
        console.error('[Litematica] 解析失败:', error);
        res.status(500).json({ 
            error: '文件解析失败: ' + error.message 
        });
    }
});

const WEB_PORT = Number(process.env.WEB_PORT) || 3000;

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.warn(`[Web] 端口 ${WEB_PORT} 已被占用，已跳过管理界面监听（不影响聊天与Bot逻辑）`);
        return;
    }
    console.error('[Web] 启动失败:', err.message);
});

server.listen(WEB_PORT, () => {
    console.log(`管理界面: http://localhost:${WEB_PORT}`);
});