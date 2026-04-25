const mineflayer = require('mineflayer');
const nbt = require('prismarine-nbt');
const varint = require('varint');
const Vec3 = require('vec3');
const config = require('./config');
const db = require('./db');
const mcData = require('minecraft-data')('1.21');
const fs = require('fs');
const path = require('path');
const { sendScanStartMessage, sendScanEndMessage } = require('./chat');
const { setupPathfinder, goto } = require('./pathfinder');
const KeepAlive = require('./keepalive');

// 全局未捕获错误处理，防止心跳超时导致进程崩溃
process.on('uncaughtException', (err) => {
    console.error('\x1b[41m%s\x1b[0m', '[致命错误]', err.message);
    // 不退出进程，继续运行
});

process.on('unhandledRejection', (reason) => {
    console.error('\x1b[43m%s\x1b[0m', '[异步错误]', reason);
});

// 加载翻译表
function loadTranslations() {
    const translationMap = {};
    try {
        const csvPath = path.join(__dirname, 'list.csv');
        const csvContent = fs.readFileSync(csvPath, 'utf-8');
        const lines = csvContent.split('\n');
        
        // 跳过标题行
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(',');
            if (parts.length >= 3) {
                // format: minecraft,en_us,zh_cn
                const id = parts[0].trim();
                const zhName = parts[2].trim();
                if (id && zhName) {
                    translationMap[id] = zhName;
                }
            }
        }
        console.log(`\x1b[36m%s\x1b[0m`, `[系统] 已加载 ${Object.keys(translationMap).length} 个翻译条目`);
    } catch (err) {
        console.warn(`\x1b[33m%s\x1b[0m`, '[警告] 无法加载翻译表:', err.message);
    }
    return translationMap;
}

const translationMap = loadTranslations();

class InventoryScanner {
    constructor() {
        // 1. 初始化基础变量
        this.bot = null;
        this.tid = 20000;
        this.isScanning = false;
        this.isPaused = false;
        this.currentAreaKeys = [];
        this.currentQueue = [];
        this.currentIndex = 0;
        this.keepalive = null; // 保活模块实例
        this.pendingQueries = new Map();
        this.responseQueue = [];
        this.isProcessingResponses = false;
        this.responseYieldEvery = config.scanParseYieldEvery || 10;
        this.responseQueueWarnSize = config.scanResponseQueueWarnSize || 50;
        this.maxPendingQueries = config.scanMaxPendingQueries || 16;
        this.maxResponseQueueSize = config.scanMaxResponseQueueSize || 8;
        this.backpressureDelay = config.scanBackpressureDelay || 25;
        this.liveStatusLine = '';
        this.liveStatusLength = 0;
        
        // 新增：跨区域进度追踪
        this.totalContainers = 0;        // 所有要扫描区域的总容器数
        this.scannedContainers = 0;      // 已扫描的容器数
        this.scanDelay = config.scanDelay || 20; // 默认扫描间隔(ms)

        this.statements = {
            updateScanSpeed: db.prepare("UPDATE scan_status SET scan_speed = ? WHERE id = 'global'"),
            updateScanPaused: db.prepare("UPDATE scan_status SET status = 'paused' WHERE id = 'global'"),
            clearItemLocations: db.prepare(`
                DELETE FROM item_locations
                WHERE chest_x = ? AND chest_y = ? AND chest_z = ?
            `),
            clearContainerItems: db.prepare(`
                DELETE FROM container_items
                WHERE container_x = ? AND container_y = ? AND container_z = ?
            `),
            upsertInventory: db.prepare(`
                INSERT INTO inventory (id, name_zh, count, last_updated)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET count = count + excluded.count, last_updated = CURRENT_TIMESTAMP
            `),
            insertItemLocation: db.prepare(`
                INSERT INTO item_locations (item_id, chest_x, chest_y, chest_z, count, last_updated)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `),
            upsertContainerItem: db.prepare(`
                INSERT INTO container_items (container_x, container_y, container_z, item_id, item_name_zh, count, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(container_x, container_y, container_z) DO UPDATE SET 
                    item_id = excluded.item_id,
                    item_name_zh = excluded.item_name_zh,
                    count = excluded.count,
                    last_updated = CURRENT_TIMESTAMP
            `)
        };

        this.writeChestSnapshotTx = db.transaction((chest, inventoryTotals, primaryItem, totalCount) => {
            this.clearChestData(chest.x, chest.y, chest.z);

            for (const [itemId, count] of inventoryTotals.entries()) {
                this.saveItem(itemId, count, chest);
            }

            if (primaryItem) {
                this.saveContainerItem(chest.x, chest.y, chest.z, primaryItem, totalCount);
            }
        });

        // 2. 关键修复：强制绑定所有方法的 this 指向
        this.initBot = this.initBot.bind(this);
        this.handleDisconnect = this.handleDisconnect.bind(this);
        this.resumeScan = this.resumeScan.bind(this);
        this.runScanLoop = this.runScanLoop.bind(this);
        this.startFullScan = this.startFullScan.bind(this);
        this.processResponseQueue = this.processResponseQueue.bind(this);
        this.updateLiveStatus = this.updateLiveStatus.bind(this);
        this.flushLiveStatus = this.flushLiveStatus.bind(this);
    }

    setScanSpeed(ms) {
        const speed = Math.max(1, Math.min(1000, Number(ms) || this.scanDelay));
        this.scanDelay = speed;
        this.statements.updateScanSpeed.run(speed);
        console.log('\x1b[36m%s\x1b[0m', `[系统] 已设置扫描速度为 ${speed} ms`);
    }

    updateLiveStatus(message) {
        if (!process.stdout.isTTY) {
            console.log(message);
            return;
        }

        const nextLine = String(message);
        const padding = ' '.repeat(Math.max(0, this.liveStatusLength - nextLine.length));
        this.liveStatusLine = nextLine;
        this.liveStatusLength = nextLine.length;
        process.stdout.write(`\r${nextLine}${padding}`);
    }

    flushLiveStatus() {
        if (!process.stdout.isTTY || this.liveStatusLength === 0) {
            return;
        }

        process.stdout.write('\n');
        this.liveStatusLine = '';
        this.liveStatusLength = 0;
    }

    // 初始化 Bot
    initBot() {
        // 如果已有实例，先清理旧监听
        if (this.bot) {
            this.bot.removeAllListeners();
            try { this.bot.quit(); } catch(e) {}
        }

        console.log('\x1b[36m%s\x1b[0m', '[Bot] 正在初始化连接...');
        
        this.bot = mineflayer.createBot({
            host: config.host,
            port: config.port,
            username: config.username,
            password: process.env.MINECRAFT_PASSWORD,
            auth: config.auth,
            version: config.version || '1.21.1',
            checkTimeoutInterval: 90000  // 增加至 90 秒，给大量查询包留出时间
        });

        // 登录成功
        this.bot.once('spawn', () => {
            console.log('\x1b[32m%s\x1b[0m', '[Bot] 已进入服务器');
            
            // 初始化寻路模块
            setupPathfinder(this.bot);

            // 启动后自动前往复位点
            const resetPos = config.resetPosition;
            if (resetPos && Number.isFinite(resetPos.x) && Number.isFinite(resetPos.y) && Number.isFinite(resetPos.z)) {
                setTimeout(async () => {
                    try {
                        console.log(`\x1b[36m%s\x1b[0m`, `[系统] 启动复位：前往 (${resetPos.x}, ${resetPos.y}, ${resetPos.z})`);
                        await goto(this.bot, resetPos.x, resetPos.y, resetPos.z);
                    } catch (err) {
                        console.warn(`[系统] 启动复位失败: ${err.message}`);
                    }
                }, 1000);
            }
            
            // 初始化保活模块
            this.keepalive = new KeepAlive(this.bot);
            this.keepalive.init();
            
            if (this.isPaused) {
                console.log('\x1b[33m%s\x1b[0m', '[系统] 检测到中断的任务，3秒后自动恢复...');
                setTimeout(() => {
                    this.resumeScan();
                }, 3000);
            }
            
            // 在 spawn 后添加 client 级别的错误处理
            if (this.bot._client) {
                this.bot._client.on('error', (err) => {
                    console.error('[Client错误]', err.message);
                    if (!this.bot.listeners('error').some(l => l === this.bot.removeAllListeners)) {
                        this.pendingQueries.clear();
                        this.handleDisconnect();
                    }
                });
            }
        });


        // NBT 响应处理
        this.bot._client.on('nbt_query_response', (packet) => {
            const { chest, latency } = this.resolvePendingChest(packet);
            if (!chest || !packet.nbt) return;
            this.responseQueue.push({
                transactionId: packet.transactionId,
                chest,
                latency,
                nbt: packet.nbt,
                queuedAt: Date.now()
            });

            this.updateLiveStatus(`[响应] tid=${packet.transactionId} pos=(${chest.x},${chest.y},${chest.z}) 网络=${latency}ms 队列=${this.responseQueue.length} 挂起=${this.pendingQueries.size}`);

            if (this.responseQueue.length >= this.responseQueueWarnSize) {
                this.flushLiveStatus();
                console.warn(`[扫描] 解析队列积压: ${this.responseQueue.length}`);
            }

            void this.processResponseQueue();
        });

        // 断线处理
        this.bot.on('end', () => {
            this.flushLiveStatus();
            console.log('\x1b[31m%s\x1b[0m', '[Bot] 与服务器断开连接');
            this.pendingQueries.clear();
            this.responseQueue = [];
            this.isProcessingResponses = false;
            // 移除 client 的错误监听，避免重复触发
            if (this.bot._client) {
                this.bot._client.removeAllListeners('error');
            }
            this.handleDisconnect();
        });

        this.bot.on('error', (err) => {
            this.flushLiveStatus();
            console.error('[Bot错误]', err.message);
            if (err.code === 'ECONNABORTED' || err.code === 'ECONNREFUSED' || err.message.includes('timed out')) {
                this.pendingQueries.clear();
                this.responseQueue = [];
                this.isProcessingResponses = false;
                this.handleDisconnect();
            }
        });
    }

    async processResponseQueue() {
        if (this.isProcessingResponses) {
            return;
        }

        this.isProcessingResponses = true;
        let processed = 0;

        try {
            while (this.responseQueue.length > 0) {
                const entry = this.responseQueue.shift();
                const queueDelay = Date.now() - entry.queuedAt;

                try {
                    const parseStart = Date.now();
                    const data = nbt.simplify(entry.nbt);
                    const parseCost = Date.now() - parseStart;
                    const items = data.Items || [];
                    const stackCount = this.countNestedStacks(items);

                    const writeStart = Date.now();
                    this.replaceChestContents(entry.chest, items);
                    const writeCost = Date.now() - writeStart;

                    this.updateLiveStatus(`[处理] tid=${entry.transactionId} pos=(${entry.chest.x},${entry.chest.y},${entry.chest.z}) 排队=${queueDelay}ms 解析=${parseCost}ms 写库=${writeCost}ms 堆栈=${stackCount} 队列=${this.responseQueue.length}`);
                } catch (err) {
                    this.flushLiveStatus();
                    console.error(`[NBT解析失败] tid=${entry.transactionId} pos=(${entry.chest.x},${entry.chest.y},${entry.chest.z})`, err.message);
                }

                processed++;
                if (processed % this.responseYieldEvery === 0) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }
        } finally {
            this.isProcessingResponses = false;
            if (this.responseQueue.length > 0) {
                void this.processResponseQueue();
            }
        }
    }

    countNestedStacks(items) {
        if (!Array.isArray(items) || items.length === 0) {
            return 0;
        }

        let stackCount = 0;
        for (const item of items) {
            stackCount++;
            const nested = item?.components?.['minecraft:container'];
            if (Array.isArray(nested)) {
                for (const entry of nested) {
                    if (entry.item) {
                        stackCount++;
                    }
                }
            }
        }

        return stackCount;
    }

    resolvePendingChest(packet) {
        const transactionId = packet?.transactionId;
        if (typeof transactionId !== 'number') {
            console.warn('[扫描] 收到缺少 transactionId 的 NBT 响应，已忽略');
            return { chest: null, latency: 0 };
        }

        const chestData = this.pendingQueries.get(transactionId);
        this.pendingQueries.delete(transactionId);

        if (!chestData) {
            console.warn(`[扫描] 未找到 transactionId=${transactionId} 对应的箱子坐标，响应已忽略`);
            return { chest: null, latency: 0 };
        }

        // 计算延迟（往返时间）
        const now = Date.now();
        const latency = now - chestData.sentTime;
        const chest = { x: chestData.x, y: chestData.y, z: chestData.z };

        return { chest, latency };
    }

    replaceChestContents(chest, items) {
        const summary = this.buildChestSummary(items);
        this.writeChestSnapshotTx(chest, summary.inventoryTotals, summary.primaryItem, summary.totalCount);
    }

    buildChestSummary(items) {
        const inventoryTotals = new Map();
        let totalCount = 0;
        let primaryItem = null;
        let primaryCount = 0;

        if (!Array.isArray(items) || items.length === 0) {
            return { inventoryTotals, primaryItem, totalCount };
        }

        for (const item of items) {
            const count = item.count || item.Count || 1;
            totalCount += count;
            inventoryTotals.set(item.id, (inventoryTotals.get(item.id) || 0) + count);

            if (count > primaryCount) {
                primaryCount = count;
                primaryItem = item.id;
            }

            const nested = item?.components?.['minecraft:container'];
            if (!Array.isArray(nested)) {
                continue;
            }

            for (const entry of nested) {
                if (!entry.item) {
                    continue;
                }

                const nestedItem = entry.item;
                const entryCount = nestedItem.count || nestedItem.Count || 1;
                totalCount += entryCount;
                inventoryTotals.set(nestedItem.id, (inventoryTotals.get(nestedItem.id) || 0) + entryCount);

                if (entryCount > primaryCount) {
                    primaryCount = entryCount;
                    primaryItem = nestedItem.id;
                }
            }
        }

        return { inventoryTotals, primaryItem, totalCount };
    }

    clearChestData(x, y, z) {
        this.statements.clearItemLocations.run(x, y, z);
        this.statements.clearContainerItems.run(x, y, z);
    }

    handleDisconnect() {
        if (this.isScanning) {
            this.isScanning = false;
            this.isPaused = true;
            this.flushLiveStatus();
            console.log(`[系统] 扫描已挂起，保留进度：区域剩余 ${this.currentAreaKeys.length}，索引 ${this.currentIndex}`);
            // 更新数据库状态为 paused（已暂停），而不是 idle
            this.statements.updateScanPaused.run();
        }
        // 避免重复触发重连
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => this.initBot(), 10000);
    }

    // 恢复扫描
    async resumeScan() {
        console.log('\x1b[35m%s\x1b[0m', '[系统] 正在恢复断点续传...');
        
        // 从数据库中读取保存的扫描参数
        const status = db.prepare("SELECT * FROM scan_status WHERE id = 'global'").get();
        if (status && status.scan_areas) {
            // 恢复之前的扫描区域
            this.currentAreaKeys = status.scan_areas.split(',').filter(k => k);
            console.log(`\x1b[36m%s\x1b[0m`, `[系统] 恢复扫描区域: ${this.currentAreaKeys.join(' -> ')}`);
        }
        if (status && typeof status.scan_speed === 'number') {
            this.scanDelay = status.scan_speed;
            console.log(`\x1b[36m%s\x1b[0m`, `[系统] 恢复扫描速度: ${this.scanDelay} ms`);
        }
        
        this.isScanning = true;
        this.isPaused = false;
        
        // 重新计算总容器数
        this.totalContainers = 0;
        const areaKeysCopy = [...this.currentAreaKeys];
        for (const key of areaKeysCopy) {
            const area = config.areas[key];
            if (area) {
                const queue = this.getContainerQueue(area);
                this.totalContainers += queue.length;
            }
        }
        
        await this.runScanLoop();
    }

    // 停止扫描
    stopScan() {
        this.flushLiveStatus();
        console.log('\x1b[33m%s\x1b[0m', '[系统] 停止扫描');
        this.isScanning = false;
        this.isPaused = false;
        this.pendingQueries.clear();
        this.responseQueue = [];
        this.isProcessingResponses = false;
        // 注意：不要清空队列，以便后续续扫
        this.currentIndex = 0;
        this.totalContainers = 0;
        this.scannedContainers = 0;
        db.prepare("UPDATE scan_status SET status = 'idle', progress = 0, current_pos = '', current_area_name = '已停止扫描' WHERE id = 'global'").run();
    }

    // 指令入口
async startFullScan(mode) {
        // 核心修复：处理字符串、数组或 'all' 关键字
        if (mode === 'all') {
            this.currentAreaKeys = ['left', 'right', 'bulk', 'unstackable'];
        } else if (typeof mode === 'string') {
            // 如果传入的是 "left,right,bulk,unstackable"，将其拆分为数组
            if (mode.includes(',')) {
                this.currentAreaKeys = mode.split(',').map(k => k.trim()).filter(k => k);
            } else {
                this.currentAreaKeys = [mode];
            }
        } else if (Array.isArray(mode)) {
            this.currentAreaKeys = [...mode];
        } else {
            console.error('[系统] 无效的扫描模式:', mode);
            return;
        }

        this.currentIndex = 0;
        this.currentQueue = [];
        this.isScanning = true;
        this.isPaused = false;
        
        // 发送开始扫描消息到游戏聊天栏
        sendScanStartMessage(this.bot);
        
        // 计算所有要扫描区域的总容器数（前置计算进度）
        this.totalContainers = 0;
        this.scannedContainers = 0;
        const areaKeysCopy = [...this.currentAreaKeys];
        for (const key of areaKeysCopy) {
            const area = config.areas[key];
            if (area) {
                const queue = this.getContainerQueue(area);
                this.totalContainers += queue.length;
            }
        }
        console.log(`\x1b[36m%s\x1b[0m`, `[系统] 总容器数: ${this.totalContainers}`);

        // 保存扫描参数到数据库，以便中断后恢复
        const areaKeysStr = this.currentAreaKeys.join(',');
        db.prepare("UPDATE scan_status SET status = 'scanning', progress = 0, scan_areas = ?, scan_speed = ? WHERE id = 'global'").run(areaKeysStr, this.scanDelay);
        
        // 打印调试信息，确保现在拆分正确了
        console.log(`\x1b[36m%s\x1b[0m`, `[系统] 任务序列已解析: ${this.currentAreaKeys.join(' -> ')}`);
        
        await this.runScanLoop();
    }

    // 核心循环
async runScanLoop() {
        while (this.currentAreaKeys.length > 0 || (this.currentQueue && this.currentIndex < this.currentQueue.length)) {
            
            // 切换区域逻辑
            if (!this.currentQueue || this.currentIndex >= this.currentQueue.length) {
                const nextKey = this.currentAreaKeys.shift();
                if (!nextKey) break;

                const area = config.areas[nextKey];
                if (!area) {
                    console.error(`[配置错误] 找不到区域: ${nextKey}`);
                    continue;
                }

                db.prepare("UPDATE scan_status SET current_area_name = ? WHERE id = 'global'").run(area.name);
                this.currentQueue = this.getContainerQueue(area);
                this.currentIndex = 0;
                console.log(`\x1b[36m%s\x1b[0m`, `[扫描] 开始新区域: ${area.name} (总数: ${this.currentQueue.length})`);
            }

            // 发包循环
            for (; this.currentIndex < this.currentQueue.length; this.currentIndex++) {
                // 断线或暂停检查
                if (!this.isScanning || this.isPaused || !this.bot || !this.bot._client) {
                    return;
                }

                while (
                    this.pendingQueries.size >= this.maxPendingQueries ||
                    this.responseQueue.length >= this.maxResponseQueueSize
                ) {
                    if (!this.isScanning || this.isPaused || !this.bot || !this.bot._client) {
                        return;
                    }
                    await new Promise(r => setTimeout(r, this.backpressureDelay));
                }

                const target = this.currentQueue[this.currentIndex];
                
                // 发送前检查连接状态
                try {
                    this.sendPacket(target.x, target.y, target.z);
                } catch (err) {
                    console.error('[发包错误]', err.message);
                    this.isPaused = true;
                    return;
                }

                // --- 核心修复点：跨区域全局进度追踪 ---
                
                // 每次扫描一个容器就增加计数
                this.scannedContainers++;

                // 每 20 个容器或最后一个容器更新一次状态，保证前端及时显示进度
                if (this.scannedContainers % 20 === 0 || this.scannedContainers === this.totalContainers) {
                    const globalProgress = this.totalContainers > 0 
                        ? (this.scannedContainers / this.totalContainers * 100).toFixed(1)
                        : 0;
                    db.prepare("UPDATE scan_status SET progress = ?, current_pos = ? WHERE id = 'global'")
                      .run(globalProgress, `${target.x},${target.y},${target.z}`);
                }

                // 2. 基础间隔，根据用户设置的扫描速度进行限速
                await new Promise(r => setTimeout(r, this.scanDelay));
            }
        }

        this.isScanning = false;
        this.isPaused = false;
        this.flushLiveStatus();
        db.prepare("UPDATE scan_status SET status = 'finished', progress = 100, current_area_name = '全部扫描完成' WHERE id = 'global'").run();
        console.log('\x1b[32m%s\x1b[0m', '[系统] 扫描任务已全部完成');
        
        // 发送扫描完成消息到游戏聊天栏
        sendScanEndMessage(this.bot);
    }

    // 容器方块类型集合（使用名字匹配，支持所有1.21版本容器）
    getContainerTypes() {
        return new Set([
            'chest', 'barrel', 'hopper', 'dispenser', 'dropper',
            'furnace', 'blast_furnace', 'smoker',
            'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box',
            'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box',
            'gray_shulker_box', 'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box',
            'blue_shulker_box', 'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
            'trapped_chest'
        ]);
    }

    // 使用环境感知获取指定区域内的所有容器块的坐标
    getContainerQueueOptimized(area) {
        if (!this.bot || !this.bot.world) {
            console.warn('[扫描] Bot世界数据未就绪，降级使用全区域扫描');
            return this.getContainerQueueFallback(area);
        }

        let containerList = [];
        const containerTypes = this.getContainerTypes();
        const xMin = Math.min(area.min.x, area.max.x);
        const xMax = Math.max(area.min.x, area.max.x);
        const yMin = Math.min(area.min.y, area.max.y);
        const yMax = Math.max(area.min.y, area.max.y);
        const zMin = Math.min(area.min.z, area.max.z);
        const zMax = Math.max(area.min.z, area.max.z);

        // 遍历已加载的块数据
        try {
            for (let y = yMax; y >= yMin; y--) {
                for (let x = xMin; x <= xMax; x++) {
                    for (let z = zMin; z <= zMax; z++) {
                        const block = this.bot.world.getBlock(new Vec3(x, y, z));
                        // 检查块是否存在且是容器类型
                        if (block && block.name && containerTypes.has(block.name)) {
                            containerList.push({ x, y, z });
                        }
                    }
                }
            }
            
            const blockCount = (xMax - xMin + 1) * (yMax - yMin + 1) * (zMax - zMin + 1);
            console.log(`\x1b[36m%s\x1b[0m`, `[扫描] 环境感知: 扫描 ${blockCount} 个块，发现 ${containerList.length} 个容器`);
        } catch (err) {
            console.warn(`[扫描] 环境感知查询出错: ${err.message}，降级使用全区域扫描`);
            return this.getContainerQueueFallback(area);
        }

        return containerList.length > 0 ? containerList : this.getContainerQueueFallback(area);
    }

    // 降级方案：全区域扫描（原始逻辑）
    getContainerQueueFallback(area) {
        let q = [];
        const xMin = Math.min(area.min.x, area.max.x);
        const xMax = Math.max(area.min.x, area.max.x);
        const yMin = Math.min(area.min.y, area.max.y);
        const yMax = Math.max(area.min.y, area.max.y);
        const zMin = Math.min(area.min.z, area.max.z);
        const zMax = Math.max(area.min.z, area.max.z);

        for (let y = yMax; y >= yMin; y--) {
            for (let x = xMin; x <= xMax; x++) {
                for (let z = zMin; z <= zMax; z++) {
                    q.push({ x, y, z });
                }
            }
        }
        return q;
    }

    getContainerQueue(area) {
        // 根据 bot 状态选择最优方案
        return this.getContainerQueueOptimized(area);
    }

    sendPacket(x, y, z) {
        if (!this.bot || !this.bot._client || this.bot._client.socket.destroyed) {
            throw new Error('客户端连接已断开');
        }
        let transactionId = null;
        try {
            transactionId = this.tid++;
            const xBI = BigInt(x) & 0x3FFFFFFn;
            const yBI = BigInt(y) & 0xFFFn;
            const zBI = BigInt(z) & 0x3FFFFFFn;
            const posLong = (xBI << 38n) | (zBI << 12n) | yBI;
            const sentTime = Date.now();
            this.pendingQueries.set(transactionId, { x, y, z, sentTime });
            const packet = Buffer.concat([
                Buffer.from(varint.encode(0x01)), 
                Buffer.from(varint.encode(transactionId)), 
                Buffer.alloc(8)
            ]);
            packet.writeBigInt64BE(posLong, packet.length - 8);
            this.bot._client.writeRaw(packet);
            this.updateLiveStatus(`[发送] tid=${transactionId} pos=(${x},${y},${z}) 挂起=${this.pendingQueries.size} 队列=${this.responseQueue.length}`);
        } catch (e) {
            if (transactionId !== null) {
                this.pendingQueries.delete(transactionId);
            }
            throw new Error(`写入包失败: ${e.message}`);
        }
    }

    saveItem(id, count, chest = null) {
        const shortId = id.replace('minecraft:', '');
        // 优先使用翻译表中的中文名称，其次使用 mcData 获取的英文名称，最后使用 ID
        const nameZh = translationMap[shortId] || mcData.itemsByName[shortId]?.displayName || id;
        
        // 更新或插入 inventory 表（总数量）
        this.statements.upsertInventory.run(id, nameZh, count);
        
        // 如果有箱子坐标，插入 item_locations 表
        if (chest) {
            this.statements.insertItemLocation.run(id, chest.x, chest.y, chest.z, count);
        }
    }

    saveContainerItem(x, y, z, itemId, count) {
        const shortId = itemId.replace('minecraft:', '');
        const nameZh = translationMap[shortId] || mcData.itemsByName[shortId]?.displayName || itemId;
        
        // 记录容器坐标和对应的主要物品，同时把当前容器的总库存数量保存到 count 字段
        this.statements.upsertContainerItem.run(x, y, z, itemId, nameZh, count);
    }
}

// 导出单例
module.exports = new InventoryScanner();