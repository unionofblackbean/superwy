const Vec3 = require('vec3');
const mcData = require('minecraft-data')('1.21');
const { gotoNear } = require('./pathfinder');
const taskQueue = require('./taskQueue');
const config = require('./config');

class KeepAlive {
    constructor(bot) {
        this.bot = bot;
        this.isRestocking = false;
        this.lookLockTarget = null;
        this.lookLockTimer = null;
        this.isLookingNow = false;
        
        // 绑定方法
        this.init = this.init.bind(this);
        this.handleHealthChange = this.handleHealthChange.bind(this);
        this.eatGoldenCarrots = this.eatGoldenCarrots.bind(this);
        this.testRestockGG = this.testRestockGG.bind(this);
        this.moveToPosition = this.moveToPosition.bind(this);
        this.restockGoldenCarrots = this.restockGoldenCarrots.bind(this);
        this.isHumanLikeEnabled = this.isHumanLikeEnabled.bind(this);
        this.getHumanLikeOptions = this.getHumanLikeOptions.bind(this);
        this.getNearestPlayerInRange = this.getNearestPlayerInRange.bind(this);
        this.lockViewToPlayerIfNeeded = this.lockViewToPlayerIfNeeded.bind(this);
        this.stopLookLock = this.stopLookLock.bind(this);
    }

    // 初始化保活模块
    init() {
        console.log('\x1b[36m%s\x1b[0m', '[保活] 保活模块已启用');
        
        // 监听健康变化
        this.bot.on('health', () => {
            this.handleHealthChange();
        });
        
        // 延迟5秒后检查一次初始状态
        setTimeout(() => {
            this.handleHealthChange();
        }, 5000);

        if (this.isHumanLikeEnabled()) {
            const options = this.getHumanLikeOptions();
            console.log('\x1b[36m%s\x1b[0m', `[拟人] 已启用，锁定距离=${options.lockDistance}，解锁距离=${options.unlockDistance}`);
            this.lookLockTimer = setInterval(() => {
                void this.lockViewToPlayerIfNeeded();
            }, options.lookIntervalMs);
            this.bot.once('end', this.stopLookLock);
        }
    }

    isHumanLikeEnabled() {
        const humanLike = config['拟人'];
        if (typeof humanLike === 'boolean') {
            return humanLike;
        }
        if (humanLike && typeof humanLike === 'object') {
            return !!humanLike.enabled;
        }
        return false;
    }

    getHumanLikeOptions() {
        const defaults = {
            lockDistance: 4,
            unlockDistance: 6,
            lookIntervalMs: 180
        };
        const humanLike = config['拟人'];
        if (!humanLike || typeof humanLike !== 'object') {
            return defaults;
        }

        const lockDistance = Number(humanLike.lockDistance);
        const unlockDistance = Number(humanLike.unlockDistance);
        const lookIntervalMs = Number(humanLike.lookIntervalMs);

        return {
            lockDistance: Number.isFinite(lockDistance) && lockDistance > 0 ? lockDistance : defaults.lockDistance,
            unlockDistance: Number.isFinite(unlockDistance) && unlockDistance > 0 ? unlockDistance : defaults.unlockDistance,
            lookIntervalMs: Number.isFinite(lookIntervalMs) && lookIntervalMs >= 50 ? lookIntervalMs : defaults.lookIntervalMs
        };
    }

    getNearestPlayerInRange(maxDistance) {
        if (!this.bot || !this.bot.entity) {
            return null;
        }

        let nearest = null;
        let nearestDist = Infinity;
        for (const [username, player] of Object.entries(this.bot.players || {})) {
            if (!player || !player.entity) continue;
            if (username === this.bot.username) continue;

            const dist = this.bot.entity.position.distanceTo(player.entity.position);
            if (dist <= maxDistance && dist < nearestDist) {
                nearest = { username, player, dist };
                nearestDist = dist;
            }
        }

        return nearest;
    }

    async lockViewToPlayerIfNeeded() {
        if (!this.bot || !this.bot.entity || this.isLookingNow) {
            return;
        }

        const { lockDistance, unlockDistance } = this.getHumanLikeOptions();

        let targetEntry = null;
        if (this.lookLockTarget) {
            const locked = this.bot.players?.[this.lookLockTarget];
            if (locked && locked.entity) {
                const dist = this.bot.entity.position.distanceTo(locked.entity.position);
                if (dist <= unlockDistance) {
                    targetEntry = { username: this.lookLockTarget, player: locked, dist };
                } else {
                    console.log('\x1b[33m%s\x1b[0m', `[拟人] 玩家 ${this.lookLockTarget} 已离开范围，解除视角锁定`);
                    this.lookLockTarget = null;
                }
            } else {
                this.lookLockTarget = null;
            }
        }

        if (!targetEntry) {
            const nearest = this.getNearestPlayerInRange(lockDistance);
            if (!nearest) {
                return;
            }

            this.lookLockTarget = nearest.username;
            targetEntry = nearest;
            console.log('\x1b[36m%s\x1b[0m', `[拟人] 玩家 ${nearest.username} 靠近，开始锁定视角`);
        }

        const eyePos = targetEntry.player.entity.position.offset(0, 1.62, 0);
        this.isLookingNow = true;
        try {
            await this.bot.lookAt(eyePos, true);
        } catch (err) {
            // 视角瞬时失败通常是实体状态变化，忽略并等待下次循环
        } finally {
            this.isLookingNow = false;
        }
    }

    stopLookLock() {
        if (this.lookLockTimer) {
            clearInterval(this.lookLockTimer);
            this.lookLockTimer = null;
        }
        this.lookLockTarget = null;
        this.isLookingNow = false;
    }

    // 处理健康变化
    handleHealthChange() {
        const health = this.bot.health;
        const food = this.bot.food;
        const foodSaturation = this.bot.foodSaturation;
        
        console.log(`\x1b[35m%s\x1b[0m`, `[保活] 血量: ${health}, 饥饿: ${food}, 饱和度: ${foodSaturation}`);
        
        // 当血量低于20时，尝试吃金胡萝卜
        if (health < 20) {
            console.log('\x1b[33m%s\x1b[0m', '[保活] 血量过低，开始吃金胡萝卜');
            this.eatGoldenCarrots().catch(err => {
                console.error('[保活] 吃胡萝卜出错:', err.message);
            });
        }
    }

    // !!gg指令 - 测试补充金胡萝卜
    async testRestockGG() {
        console.log('\x1b[36m%s\x1b[0m', '[测试] 触发!!gg指令，开始补充金胡萝卜...');
        await this.restockGoldenCarrots();
    }

    // 移动到指定位置的辅助方法
    async moveToPosition(x, y, z) {
        try {
            await gotoNear(this.bot, x, y, z, 5, {
                timeoutMs: 30000,
                source: 'keepalive.moveToPosition',
                title: `保活移动到 ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}`
            });
        } catch (error) {
            console.error('\x1b[31m%s\x1b[0m', '[移动错误]', error.message);
            throw error;
        }
    }

    // 补充金胡萝卜 - 从潜影盒取64个
    async restockGoldenCarrots() {
        if (this.isRestocking) {
            console.log('\x1b[33m%s\x1b[0m', '[保活] 正在补充中，跳过本次请求');
            return;
        }

        return taskQueue.enqueueTask({
            type: 'movement',
            title: '补充金胡萝卜',
            meta: {
                source: 'keepalive.restockGoldenCarrots',
                target: '120, 50, 8'
            },
            executor: async ({ throwIfAborted }) => {
                this.isRestocking = true;
                let currentPos = null;
                
                try {
                    currentPos = this.bot.entity.position.clone();
                    console.log(`\x1b[36m%s\x1b[0m`, `[保活] 已记录当前位置: (${currentPos.x.toFixed(1)}, ${currentPos.y.toFixed(1)}, ${currentPos.z.toFixed(1)})`);
                    
                    const shulkerPos = new Vec3(120, 50, 8);
                    console.log('\x1b[36m%s\x1b[0m', '[保活] 正在移动到潜影盒...');
                    
                    try {
                        await this.moveToPosition(shulkerPos.x + 0.5, shulkerPos.y, shulkerPos.z + 0.5);
                        console.log('\x1b[36m%s\x1b[0m', '[保活] 已到达潜影盒位置');
                    } catch (err) {
                        if (taskQueue.isTaskCancelledError(err)) {
                            throw err;
                        }
                        console.log('\x1b[33m%s\x1b[0m', `[保活] 寻路失败: ${err.message}，但仍尝试打开潜影盒`);
                    }
                    
                    throwIfAborted();
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    const block = this.bot.blockAt(shulkerPos);
                    if (!block) {
                        console.log('\x1b[31m%s\x1b[0m', '[保活] 未找到潜影盒！');
                        return;
                    }
                    
                    console.log(`\x1b[36m%s\x1b[0m`, `[保活] 打开潜影盒: ${block.name}`);
                    await this.bot.openBlock(block);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    const window = this.bot.currentWindow;
                    if (!window) {
                        console.log('\x1b[31m%s\x1b[0m', '[保活] 未能打开潜影盒窗口！');
                        return;
                    }
                    
                    console.log('\x1b[36m%s\x1b[0m', '[保活] 潜影盒已打开，开始取物...');
                    
                    let carrots = this.bot.inventory.items().find(item => 
                        item.name === 'golden_carrot' || item.type === mcData.itemsByName.golden_carrot.id
                    );
                    const currentCount = carrots ? carrots.count : 0;
                    const needCount = 64 - currentCount;
                    
                    console.log(`\x1b[36m%s\x1b[0m`, `[保活] 需要取${needCount}个金胡萝卜`);
                    
                    for (let slot = 0; slot < window.inventoryStart; slot++) {
                        throwIfAborted();
                        const item = window.slots[slot];
                        if (item && (item.name === 'golden_carrot' || item.type === mcData.itemsByName.golden_carrot.id)) {
                            console.log(`\x1b[36m%s\x1b[0m`, `[保活] 找到金胡萝卜，点击取出`);
                            await this.bot.clickWindow(slot, 0, 0);
                            await new Promise(resolve => setTimeout(resolve, 100));
                            
                            const updated = this.bot.inventory.items().find(item => 
                                item.name === 'golden_carrot' || item.type === mcData.itemsByName.golden_carrot.id
                            );
                            if (updated && updated.count >= 64) {
                                console.log('\x1b[36m%s\x1b[0m', '[保活] 已取足64个金胡萝卜');
                                break;
                            }
                        }
                    }
                    
                    try {
                        await this.bot.closeWindow(window);
                    } catch (e) {
                        this.bot.inventory.closeWindow();
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    if (currentPos) {
                        console.log('\x1b[36m%s\x1b[0m', '[保活] 正在返回原位置...');
                        try {
                            await this.moveToPosition(currentPos.x, currentPos.y, currentPos.z);
                            console.log('\x1b[32m%s\x1b[0m', '[保活] 已返回原位置，补充完成');
                        } catch (err) {
                            if (taskQueue.isTaskCancelledError(err)) {
                                throw err;
                            }
                            console.log('\x1b[33m%s\x1b[0m', `[保活] 返回原位置失败: ${err.message}`);
                        }
                    }
                } catch (error) {
                    if (taskQueue.isTaskCancelledError(error)) {
                        throw error;
                    }
                    console.error('\x1b[31m%s\x1b[0m', '[保活] 补充金胡萝卜时出错:', error.message);
                } finally {
                    this.isRestocking = false;
                }
            }
        });
    }

    // 吃金胡萝卜直到饱和度满
    async eatGoldenCarrots() {
        try {
            // 查找背包中的金胡萝卜
            let goldenCarrot = this.bot.inventory.items().find(item => 
                item.name === 'golden_carrot' || item.type === mcData.itemsByName.golden_carrot.id
            );
            
            // 如果金胡萝卜小于64个，先补充
            if (!goldenCarrot || goldenCarrot.count < 64) {
                console.log('\x1b[33m%s\x1b[0m', '[保活] 金胡萝卜不足64个，开始补充...');
                await this.restockGoldenCarrots();
                // 重新查找
                goldenCarrot = this.bot.inventory.items().find(item => 
                    item.name === 'golden_carrot' || item.type === mcData.itemsByName.golden_carrot.id
                );
            }
            
            if (!goldenCarrot) {
                console.log('\x1b[31m%s\x1b[0m', '[保活] 补充后背包中仍没有金胡萝卜！');
                return;
            }
            
            console.log(`\x1b[36m%s\x1b[0m`, `[保活] 找到 ${goldenCarrot.count} 个金胡萝卜`);
            
            // 吃金胡萝卜直到饱和度满（20.0）或没有更多金胡萝卜
            while (this.bot.foodSaturation < 20.0 && goldenCarrot.count > 0) {
                console.log(`\x1b[36m%s\x1b[0m`, `[保活] 正在吃金胡萝卜，当前饱和度: ${this.bot.foodSaturation}`);
                
                // 装备到手上
                await this.bot.equip(goldenCarrot, 'hand');
                
                // 吃掉
                await this.bot.consume();
                
                // 等待一下
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // 重新查找（因为数量可能变化）
                const updatedCarrot = this.bot.inventory.items().find(item => 
                    item.name === 'golden_carrot' || item.type === mcData.itemsByName.golden_carrot.id
                );
                
                if (!updatedCarrot || updatedCarrot.count === 0) {
                    console.log('\x1b[33m%s\x1b[0m', '[保活] 金胡萝卜已用完');
                    break;
                }
                
                goldenCarrot.count = updatedCarrot.count;
            }
            
            console.log(`\x1b[32m%s\x1b[0m`, `[保活] 吃完金胡萝卜，当前饱和度: ${this.bot.foodSaturation}`);
            
        } catch (error) {
            console.error('\x1b[31m%s\x1b[0m', '[保活] 吃金胡萝卜时出错:', error.message);
        }
    }
}

module.exports = KeepAlive;
