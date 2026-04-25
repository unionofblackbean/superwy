const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const Vec3 = require('vec3');
const config = require('./config');
const taskQueue = require('./taskQueue');

const GOTO_TIMEOUT_MS = Math.max(3000, Number(config.gotoPathTimeoutMs) || 12000);

function setupPathfinder(bot) {
    if (!bot) {
        console.error('[寻路模块] 未检测到有效的 Bot 实例');
        return;
    }

    // 加载 pathfinder 插件
    bot.loadPlugin(pathfinder);

    console.log('\x1b[35m%s\x1b[0m', '[寻路模块] 已加载');

    // 设置默认移动设置 - 禁止挖方块
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    
    // 禁止寻路时挖掉方块
    defaultMove.canDig = false;
    
    bot.pathfinder.setMovements(defaultMove);
    console.log('\x1b[36m%s\x1b[0m', '[寻路模块] 已禁用挖掘功能');
}

function attemptGoal(bot, x, y, z, range, timeoutMs, helpers = {}) {
    return new Promise((resolve, reject) => {
        const target = new Vec3(x, y, z);
        const currentPos = bot.entity && bot.entity.position ? bot.entity.position : null;
        if (currentPos && currentPos.distanceTo(target) <= range) {
            resolve();
            return;
        }

        const goal = new GoalNear(x, y, z, range);
        let settled = false;
        let restoreCancel = null;

        const cleanup = () => {
            bot.removeListener('goal_reached', onReached);
            if (helpers.signal) {
                helpers.signal.removeEventListener('abort', onAbort);
            }
            clearTimeout(timeout);
            if (typeof restoreCancel === 'function') {
                restoreCancel();
            }
        };

        const finish = (handler) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            handler();
        };

        const onReached = (reachedGoal) => {
            if (reachedGoal === goal) {
                finish(resolve);
            }
        };

        const onAbort = () => {
            try {
                bot.pathfinder.stop();
            } catch (error) {
                console.warn('[寻路] 终止当前寻路失败:', error.message);
            }
            finish(() => reject(new taskQueue.TaskCancelledError('任务队列已终止')));
        };

        bot.on('goal_reached', onReached);
        restoreCancel = helpers.setCancel ? helpers.setCancel(() => bot.pathfinder.stop()) : null;
        if (helpers.signal) {
            if (helpers.signal.aborted) {
                onAbort();
                return;
            }
            helpers.signal.addEventListener('abort', onAbort, { once: true });
        }

        bot.pathfinder.setGoal(goal);

        const timeout = setTimeout(() => {
            const latestPos = bot.entity && bot.entity.position ? bot.entity.position : null;
            if (latestPos && latestPos.distanceTo(target) <= range) {
                finish(resolve);
                return;
            }

            try {
                bot.pathfinder.stop();
            } catch (error) {
                console.warn('[寻路] 停止超时寻路失败:', error.message);
            }
            finish(() => reject(new Error(`无法到达 ${x}, ${y}, ${z} (range=${range})`)));
        }, timeoutMs);
    });
}

async function executeGoto(bot, x, y, z, options = {}, helpers = {}) {
    const timeoutMs = Math.max(3000, Number(options.timeoutMs) || GOTO_TIMEOUT_MS);
    const targetRange = Number.isFinite(options.range) ? options.range : 1;
    const allowFallback = options.allowFallback !== false && targetRange === 1;

    if (helpers.throwIfAborted) {
        helpers.throwIfAborted();
    }

    if (!bot || !bot.pathfinder) {
        console.error('[寻路] Pathfinder 未初始化');
        throw new Error('Pathfinder未初始化');
    }

    console.log(`\x1b[36m%s\x1b[0m`, `[寻路] 正在前往 ${x}, ${y}, ${z} (range=${targetRange})`);
    try {
        await attemptGoal(bot, x, y, z, targetRange, timeoutMs, helpers);
        console.log(`\x1b[32m%s\x1b[0m`, `[寻路] 已到达 ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)} (range=${targetRange})`);
        return;
    } catch (error) {
        if (!allowFallback || taskQueue.isTaskCancelledError(error)) {
            throw error;
        }

        const target = new Vec3(x, y, z);
        const currentPos = bot.entity && bot.entity.position ? bot.entity.position : null;
        const distance = currentPos ? currentPos.distanceTo(target) : Infinity;

        if (distance <= 5) {
            console.log(`\x1b[33m%s\x1b[0m`, `[寻路] 精确坐标不可达，但当前已在目标附近 ${distance.toFixed(2)}，按成功处理`);
            return;
        }

        console.log(`\x1b[33m%s\x1b[0m`, `[寻路] 精确坐标不可达，当前距离目标 ${distance.toFixed(2)} > 5，尝试放宽范围到5: ${error.message}`);
    }

    if (helpers.throwIfAborted) {
        helpers.throwIfAborted();
    }

    console.log(`\x1b[36m%s\x1b[0m`, `[寻路] 正在前往 ${x}, ${y}, ${z} (range=5)`);
    await attemptGoal(bot, x, y, z, 5, timeoutMs, helpers);
    console.log(`\x1b[32m%s\x1b[0m`, `[寻路] 已到达 ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)} 附近 (range=5)`);
}

function formatTarget(x, y, z, range) {
    return `${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)} (range=${range})`;
}

function goto(bot, x, y, z, options = {}) {
    return taskQueue.enqueueTask({
        type: 'movement',
        title: options.title || `前往 ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}`,
        meta: {
            source: options.source || 'pathfinder.goto',
            target: formatTarget(x, y, z, 1)
        },
        executor: (helpers) => executeGoto(bot, x, y, z, options, helpers)
    });
}

function gotoNear(bot, x, y, z, range = 5, options = {}) {
    const normalizedRange = Math.max(1, Number(range) || 5);
    return taskQueue.enqueueTask({
        type: 'movement',
        title: options.title || `接近 ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}`,
        meta: {
            source: options.source || 'pathfinder.gotoNear',
            target: formatTarget(x, y, z, normalizedRange)
        },
        executor: (helpers) => executeGoto(bot, x, y, z, {
            ...options,
            range: normalizedRange,
            allowFallback: false
        }, helpers)
    });
}

module.exports = { setupPathfinder, goto, gotoNear };